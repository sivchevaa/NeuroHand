import ExpoModulesCore
import AVFoundation
import MediaPipeTasksVision

// Coordinate system contract (must match what index.tsx consumes):
//   x, y  — normalized 0-1, origin at screen top-left, front camera already mirrored
//   confidence — 0-1 (1.0 for every landmark when a hand is detected; MediaPipe
//                HandLandmarker only returns landmarks it is confident about)
//
// Orientation note: UIImage.Orientation.leftMirrored tells MediaPipe to rotate
// the landscape sensor buffer 90° CCW then mirror horizontally, producing the
// same portrait-with-selfie-mirror space that the previous Vision implementation
// produced with CGImagePropertyOrientation.leftMirrored. MediaPipe uses a
// top-left Y origin so no Y-flip is needed (unlike Vision's bottom-left origin).

class HandTrackerView: ExpoView {
  let onHandLandmarks = EventDispatcher()

  private var captureSession: AVCaptureSession?
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private let videoQueue = DispatchQueue(label: "com.neurohand.video", qos: .userInteractive)
  private var handLandmarker: HandLandmarker?

  // Cap dispatch rate to ~30 fps to avoid queue back-pressure on the ML pipeline
  private var lastProcessed: CFTimeInterval = 0
  private let minInterval: CFTimeInterval = 1.0 / 30.0

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    setupHandLandmarker()
    checkPermissionAndSetup()
  }

  private func setupHandLandmarker() {
    guard let modelPath = Bundle(for: type(of: self)).path(
      forResource: "hand_landmarker",
      ofType: "task"
    ) else {
      return
    }

    let options = HandLandmarkerOptions()
    options.baseOptions.modelAssetPath = modelPath
    options.runningMode = .liveStream
    options.numHands = 1
    options.minHandDetectionConfidence = 0.5
    options.minHandPresenceConfidence = 0.5
    options.minTrackingConfidence = 0.5
    options.handLandmarkerLiveStreamDelegate = self

    handLandmarker = try? HandLandmarker(options: options)
  }

  private func checkPermissionAndSetup() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      setupCapture()

    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
        if granted {
          DispatchQueue.main.async {
            self?.setupCapture()
          }
        }
      }

    default:
      break
    }
  }

  private func setupCapture() {
    let session = AVCaptureSession()
    session.sessionPreset = .hd1280x720

    guard
      let device = AVCaptureDevice.default(
        .builtInWideAngleCamera,
        for: .video,
        position: .front
      ),
      let input = try? AVCaptureDeviceInput(device: device),
      session.canAddInput(input)
    else {
      return
    }

    session.addInput(input)

    let output = AVCaptureVideoDataOutput()
    output.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
    ]
    output.alwaysDiscardsLateVideoFrames = true
    output.setSampleBufferDelegate(self, queue: videoQueue)

    guard session.canAddOutput(output) else {
      return
    }

    session.addOutput(output)

    let preview = AVCaptureVideoPreviewLayer(session: session)
    preview.videoGravity = .resizeAspectFill

    // Mirror the preview so it feels like a selfie camera
    if let conn = preview.connection, conn.isVideoMirroringSupported {
      conn.automaticallyAdjustsVideoMirroring = false
      conn.isVideoMirrored = true
    }

    layer.addSublayer(preview)

    captureSession = session
    previewLayer = preview

    DispatchQueue.global(qos: .userInitiated).async {
      session.startRunning()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    previewLayer?.frame = bounds
  }

  deinit {
    captureSession?.stopRunning()
  }
}

extension HandTrackerView: AVCaptureVideoDataOutputSampleBufferDelegate {
  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    let now = CACurrentMediaTime()
    guard now - lastProcessed >= minInterval else {
      return
    }
    lastProcessed = now

    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      return
    }

    guard let mpImage = try? MPImage(
      pixelBuffer: pixelBuffer,
      orientation: .leftMirrored
    ) else {
      return
    }

    let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    let timestampInMilliseconds = Int(CMTimeGetSeconds(presentationTime) * 1000)

    guard timestampInMilliseconds >= 0 else {
      return
    }

    try? handLandmarker?.detectAsync(
      image: mpImage,
      timestampInMilliseconds: timestampInMilliseconds
    )
  }
}

extension HandTrackerView: HandLandmarkerLiveStreamDelegate {
  func handLandmarker(
    _ handLandmarker: HandLandmarker,
    didFinishDetection result: HandLandmarkerResult?,
    timestampInMilliseconds: Int,
    error: Error?
  ) {
    guard let result = result, let hand = result.landmarks.first else {
      onHandLandmarks([
        "detected": false,
        "landmarks": []
      ])
      return
    }

    // All 21 landmarks are structurally guaranteed when HandLandmarker detects a
    // hand; presence defaults to 1.0 when the model doesn't populate the field.
    let landmarks: [[String: Double]] = hand.map { lm in
      [
        "x": Double(lm.x),
        "y": Double(lm.y),
        "confidence": lm.presence?.doubleValue ?? 1.0
      ]
    }

    onHandLandmarks([
      "detected": true,
      "landmarks": landmarks
    ])
  }
}