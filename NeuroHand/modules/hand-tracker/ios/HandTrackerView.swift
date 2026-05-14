import ExpoModulesCore
import AVFoundation
import UIKit
import MediaPipeTasksVision

// Coordinate system contract (must match what index.tsx consumes):
//   x, y — normalized 0-1 in the visible preview layer, origin at top-left.
//   MediaPipe landmarks are converted through AVCaptureVideoPreviewLayer, so
//   the preview layer owns portrait orientation, selfie mirroring, videoGravity,
//   scaling, and resizeAspectFill cropping.
//   React should render with x * measuredOverlayWidth and y * measuredOverlayHeight.
//   confidence — 0-1 (1.0 for every landmark when MediaPipe does not provide
//   per-landmark presence).

class HandTrackerView: ExpoView {
  let onHandLandmarks = EventDispatcher()

  private var captureSession: AVCaptureSession?
  private var previewLayer: AVCaptureVideoPreviewLayer?
  private let videoQueue = DispatchQueue(label: "com.neurohand.video", qos: .userInteractive)
  private var handLandmarker: HandLandmarker?

  // Temporary orientation switch for device testing. Keep the video data output
  // unmirrored; previewLayer.layerPointConverted applies preview mirroring.
  private let mediaPipeImageOrientation: UIImage.Orientation = .up
  // Test candidates if the model appears rotated after a clean rebuild:
  // .up, .upMirrored, .left, .leftMirrored

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

    if let connection = output.connection(with: .video) {
      configureVideoConnection(connection, mirrored: false)
    }

    let preview = AVCaptureVideoPreviewLayer(session: session)
    preview.videoGravity = .resizeAspectFill

    if let connection = preview.connection {
      configureVideoConnection(connection, mirrored: true)
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

    if let connection = previewLayer?.connection {
      configureVideoConnection(connection, mirrored: true)
    }
  }

  deinit {
    captureSession?.stopRunning()
  }

  private func configureVideoConnection(_ connection: AVCaptureConnection, mirrored: Bool) {
    if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }

    if connection.isVideoMirroringSupported {
      connection.automaticallyAdjustsVideoMirroring = false
      connection.isVideoMirrored = mirrored
    }
  }

  private func captureDevicePoint(x: CGFloat, y: CGFloat) -> CGPoint {
    // With the video data output configured as portrait and unmirrored, MPImage
    // .up landmarks are already normalized AVCapture capture-device points:
    // x/y are 0-1 with a top-left origin before preview mirroring/cropping.
    CGPoint(x: x, y: y)
  }
}

extension HandTrackerView: AVCaptureVideoDataOutputSampleBufferDelegate {
  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    configureVideoConnection(connection, mirrored: false)

    let now = CACurrentMediaTime()
    guard now - lastProcessed >= minInterval else {
      return
    }
    lastProcessed = now

    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      return
    }

    let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    let timestampInMilliseconds = Int(CMTimeGetSeconds(presentationTime) * 1000)

    guard timestampInMilliseconds >= 0 else {
      return
    }

    guard let mpImage = try? MPImage(
      pixelBuffer: pixelBuffer,
      orientation: mediaPipeImageOrientation
    ) else {
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
      DispatchQueue.main.async { [weak self] in
        self?.onHandLandmarks([
          "detected": false,
          "landmarks": []
        ])
      }
      return
    }

    DispatchQueue.main.async { [weak self] in
      guard let self else { return }

      let previewSize = self.bounds.size

      guard let previewLayer = self.previewLayer,
            previewSize.width > 0,
            previewSize.height > 0 else {
        self.onHandLandmarks([
          "detected": false,
          "landmarks": []
        ])
        return
      }

      // All 21 landmarks are structurally guaranteed when HandLandmarker detects
      // a hand. Convert MediaPipe's normalized capture-device point through the
      // preview layer, which applies resizeAspectFill, orientation, and mirroring
      // exactly like the visible camera preview.
      let landmarks: [[String: Double]] = hand.map { lm in
        let capturePoint = self.captureDevicePoint(
          x: CGFloat(lm.x),
          y: CGFloat(lm.y)
        )
        let layerPoint = previewLayer.layerPointConverted(fromCaptureDevicePoint: capturePoint)

        return [
          "x": Double(layerPoint.x / previewSize.width),
          "y": Double(layerPoint.y / previewSize.height),
          "confidence": lm.presence?.doubleValue ?? 1.0
        ]
      }

      self.onHandLandmarks([
        "detected": true,
        "landmarks": landmarks
      ])
    }
  }
}
