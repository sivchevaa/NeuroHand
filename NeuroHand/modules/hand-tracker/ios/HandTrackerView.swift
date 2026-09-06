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
  private var photoOutput: AVCapturePhotoOutput?
  private let videoQueue = DispatchQueue(label: "com.neurohand.video", qos: .userInteractive)
  private var handLandmarker: HandLandmarker?

  // Kept alive for the duration of a single capturePhoto call — AVCapturePhotoOutput
  // holds only a weak/unretained reference to its delegate.
  private var activeSnapshotDelegate: PhotoCaptureDelegate?

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

    // Still-photo output for calibration snapshots, added alongside the existing
    // video data output. Does not touch the MediaPipe pipeline above.
    let stillOutput = AVCapturePhotoOutput()
    if session.canAddOutput(stillOutput) {
      session.addOutput(stillOutput)

      if let connection = stillOutput.connection(with: .video) {
        // Mirrored to match the preview (selfie view), so the returned photo's
        // framing matches what the patient sees on screen.
        configureVideoConnection(connection, mirrored: true)
      }

      matchPhotoDimensionsToVideoFormat(stillOutput, device: device)

      photoOutput = stillOutput
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

    if let connection = photoOutput?.connection(with: .video) {
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

  // Aligns the photo output's captured field of view with the video stream's.
  // Without this, AVCapturePhotoOutput can default (as of iOS 16's
  // maxPhotoDimensions-based capture) to the sensor's native aspect ratio —
  // often wider than the 16:9 video preset — while the preview layer (and
  // metadataOutputRectConverted, which is calibrated to the video stream) has
  // no knowledge of that. Cropping a wider-FOV photo with a rect meant for
  // the narrower video stream over-crops it, i.e. silently zooms in.
  // Standard AVFoundation format introspection only — no device checks.
  private func matchPhotoDimensionsToVideoFormat(_ photoOutput: AVCapturePhotoOutput, device: AVCaptureDevice) {
    guard #available(iOS 16.0, *) else { return }

    let videoDimensions = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
    let videoAspect = Double(videoDimensions.width) / Double(videoDimensions.height)

    let bestMatch = device.activeFormat.supportedMaxPhotoDimensions.min { a, b in
      let aspectA = Double(a.width) / Double(a.height)
      let aspectB = Double(b.width) / Double(b.height)
      return abs(aspectA - videoAspect) < abs(aspectB - videoAspect)
    }

    if let bestMatch {
      photoOutput.maxPhotoDimensions = bestMatch
    }
  }

  private func captureDevicePoint(x: CGFloat, y: CGFloat) -> CGPoint {
    // With the video data output configured as portrait and unmirrored, MPImage
    // .up landmarks are already normalized AVCapture capture-device points:
    // x/y are 0-1 with a top-left origin before preview mirroring/cropping.
    CGPoint(x: x, y: y)
  }

  // Captures a single still photo, cropped and mirrored to match exactly what
  // the preview layer shows, and writes it to a temp JPEG file. Landmarks are
  // read from the same normalized preview-layer space (see the coordinate
  // system contract at the top of this file), so the returned image's pixels
  // and the landmark coordinates for the same moment refer to the same frame.
  func takeSnapshot() async throws -> String {
    guard let photoOutput = photoOutput, let previewLayer = previewLayer else {
      throw HandTrackerSnapshotError.notReady
    }

    // Read layer geometry on the main thread, matching how the rest of this
    // file (see HandLandmarkerLiveStreamDelegate below) treats `bounds` /
    // `previewLayer` as main-thread-owned UIKit state — AsyncFunction calls
    // from Expo Modules Core are not guaranteed to run on the main thread,
    // and this must reflect the layout current at the moment of capture.
    let visibleRect = await MainActor.run {
      previewLayer.metadataOutputRectConverted(fromLayerRect: previewLayer.bounds)
    }

    let photo: AVCapturePhoto = try await withCheckedThrowingContinuation { continuation in
      let settings = AVCapturePhotoSettings()
      settings.flashMode = .off
      if #available(iOS 16.0, *) {
        settings.maxPhotoDimensions = photoOutput.maxPhotoDimensions
      }

      let delegate = PhotoCaptureDelegate { result in
        continuation.resume(with: result)
      }
      // Retain the delegate until its callback fires — capturePhoto keeps
      // only a weak reference.
      self.activeSnapshotDelegate = delegate
      photoOutput.capturePhoto(with: settings, delegate: delegate)
    }
    activeSnapshotDelegate = nil

    guard
      let fileData = photo.fileDataRepresentation(),
      let capturedImage = UIImage(data: fileData)
    else {
      throw HandTrackerSnapshotError.captureFailed
    }

    // Captured before normalization discards it below — this is what tells us
    // how the raw (landscape, unrotated) buffer relates to the portrait image
    // normalizedUpImage produces, and is what the crop-rect transform below
    // is actually derived from.
    let rawOrientation = capturedImage.imageOrientation

    // Force the image's EXIF orientation/mirroring into actual pixel data —
    // AVCapturePhotoOutput JPEGs may carry orientation as metadata rather than
    // rotated pixels, and cropping via CGImage below ignores that metadata.
    let normalizedImage = normalizedUpImage(capturedImage)

    guard let normalizedCGImage = normalizedImage.cgImage else {
      throw HandTrackerSnapshotError.captureFailed
    }

    // metadataOutputRectConverted returns a rect in the capture device's own
    // unrotated (landscape) coordinate space — a fixed convention independent
    // of any connection's videoOrientation setting. normalizedCGImage above
    // has already been rotated to portrait, so visibleRect must be carried
    // into that same space first, or its width/height fractions land on the
    // wrong axes (this was the bug: a landscape height-fraction was applied
    // as a portrait height-fraction instead of a width-fraction).
    let displayRect = rectInDisplaySpace(visibleRect, rawOrientation: rawOrientation)

    // Crop to exactly the region the preview layer shows (undoes resizeAspectFill's
    // extra sensor content), using the same standard AVFoundation API used for
    // tap-to-focus-style preview/image coordinate mapping — no device-specific math.
    // visibleRect was computed on the main thread above, against the layout
    // current at the moment capture was initiated.
    let imageWidth = CGFloat(normalizedCGImage.width)
    let imageHeight = CGFloat(normalizedCGImage.height)
    let cropRect = CGRect(
      x: displayRect.origin.x * imageWidth,
      y: displayRect.origin.y * imageHeight,
      width: displayRect.width * imageWidth,
      height: displayRect.height * imageHeight
    ).intersection(CGRect(x: 0, y: 0, width: imageWidth, height: imageHeight))

    guard let croppedCGImage = normalizedCGImage.cropping(to: cropRect) else {
      throw HandTrackerSnapshotError.cropFailed
    }

    guard let jpegData = UIImage(cgImage: croppedCGImage).jpegData(compressionQuality: 0.9) else {
      throw HandTrackerSnapshotError.encodingFailed
    }

    let fileURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString)
      .appendingPathExtension("jpg")
    try jpegData.write(to: fileURL)

    return fileURL.absoluteString
  }

  // Maps a normalized rect (origin top-left, 0-1, y-down) from the RAW
  // (pre-orientation) pixel buffer's coordinate space into the space of the
  // upright DISPLAY image that buffer becomes once oriented — i.e. what
  // normalizedUpImage(_:) produces. Each case is derived from
  // UIImage.Orientation's documented rotation/mirror relative to raw data
  // (see UIImage.h), not assumed to always be a 90-degree swap — so if the
  // orientation this device/connection combination actually produces ever
  // changes, the matching case is used automatically instead of a stale one.
  //
  // Note: this device's capture is always a centered resizeAspectFill crop
  // along one axis, which happens to make the .left/.right and .*Mirrored
  // position formulas numerically indistinguishable from real captures (the
  // symmetry hides any position error) — only the width/height swap is
  // empirically checkable. Both were still derived independently from
  // UIImage.h's documented semantics for every case, cross-checked two ways
  // (composing the mirror before vs. after the rotation) rather than guessed.
  private func rectInDisplaySpace(_ rect: CGRect, rawOrientation: UIImage.Orientation) -> CGRect {
    let x = rect.origin.x
    let y = rect.origin.y
    let w = rect.size.width
    let h = rect.size.height

    switch rawOrientation {
    case .up:
      return rect
    case .down:
      return CGRect(x: 1 - x - w, y: 1 - y - h, width: w, height: h)
    case .left:
      return CGRect(x: y, y: 1 - x - w, width: h, height: w)
    case .right:
      return CGRect(x: 1 - y - h, y: x, width: h, height: w)
    case .upMirrored:
      return CGRect(x: 1 - x - w, y: y, width: w, height: h)
    case .downMirrored:
      return CGRect(x: x, y: 1 - y - h, width: w, height: h)
    case .leftMirrored:
      return CGRect(x: y, y: x, width: h, height: w)
    case .rightMirrored:
      return CGRect(x: 1 - y - h, y: 1 - x - w, width: h, height: w)
    @unknown default:
      return rect
    }
  }

  // Redraws the image so its pixel data matches .up orientation exactly,
  // regardless of whether the source encoded rotation/mirroring as EXIF
  // metadata or as already-rotated pixels.
  private func normalizedUpImage(_ image: UIImage) -> UIImage {
    if image.imageOrientation == .up {
      return image
    }

    let renderer = UIGraphicsImageRenderer(size: image.size)
    return renderer.image { _ in
      image.draw(in: CGRect(origin: .zero, size: image.size))
    }
  }
}

private enum HandTrackerSnapshotError: Error {
  case notReady
  case captureFailed
  case cropFailed
  case encodingFailed
}

private class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
  private let completion: (Result<AVCapturePhoto, Error>) -> Void

  init(completion: @escaping (Result<AVCapturePhoto, Error>) -> Void) {
    self.completion = completion
  }

  func photoOutput(
    _ output: AVCapturePhotoOutput,
    didFinishProcessingPhoto photo: AVCapturePhoto,
    error: Error?
  ) {
    if let error = error {
      completion(.failure(error))
    } else {
      completion(.success(photo))
    }
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
