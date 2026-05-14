package expo.modules.handtracker

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.MirrorMode
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.camera.view.transform.CoordinateTransform
import androidx.camera.view.transform.ImageProxyTransformFactory
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.google.mediapipe.framework.image.MediaImageBuilder
import com.google.mediapipe.framework.image.MPImage
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarkerResult
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

private const val TAG = "HandTrackerView"

data class HandLandmarkEvent(
  @Field val detected: Boolean,
  @Field val landmarks: List<HandLandmarkRecord>
) : Record

data class HandLandmarkRecord(
  @Field val x: Double,
  @Field val y: Double,
  @Field val confidence: Double
) : Record

@SuppressLint("ViewConstructor")
class HandTrackerView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  private val onHandLandmarks by EventDispatcher<HandLandmarkEvent>()

  private val previewView = PreviewView(context).apply {
    layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }

  private val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()
  private val transformFactory = ImageProxyTransformFactory().apply {
    isUsingCropRect = true
    isUsingRotationDegrees = true
  }

  private var cameraProvider: ProcessCameraProvider? = null
  private var previewUseCase: Preview? = null
  private var analysisUseCase: ImageAnalysis? = null
  private var handLandmarker: HandLandmarker? = null
  private var latestCoordinateTransform: CoordinateTransform? = null
  private var latestImageWidth = 0
  private var latestImageHeight = 0
  private var latestImageRotation = 0

  init {
    addView(previewView)
    setupHandLandmarker()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    startCameraIfPermitted()
  }

  override fun onDetachedFromWindow() {
    stopCamera()
    super.onDetachedFromWindow()
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    previewView.layout(0, 0, right - left, bottom - top)
  }

  private fun setupHandLandmarker() {
    val baseOptions = BaseOptions.builder()
      .setModelAssetPath("hand_landmarker.task")
      .build()

    val options = HandLandmarker.HandLandmarkerOptions.builder()
      .setBaseOptions(baseOptions)
      .setRunningMode(RunningMode.LIVE_STREAM)
      .setNumHands(1)
      .setMinHandDetectionConfidence(0.5f)
      .setMinHandPresenceConfidence(0.5f)
      .setMinTrackingConfidence(0.5f)
      .setResultListener(::handleLandmarkerResult)
      .setErrorListener { error ->
        Log.e(TAG, "MediaPipe hand detection failed", error)
        emitNoHand()
      }
      .build()

    handLandmarker = HandLandmarker.createFromOptions(context, options)
  }

  private fun startCameraIfPermitted() {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      // The React screen already requests camera permission via expo-camera.
      // Native Android only starts CameraX after that permission is granted.
      emitNoHand()
      return
    }

    val lifecycleOwner = appContext.throwingActivity as? LifecycleOwner ?: run {
      Log.e(TAG, "Current activity is not a LifecycleOwner; cannot bind CameraX")
      emitNoHand()
      return
    }

    val providerFuture = ProcessCameraProvider.getInstance(context)
    providerFuture.addListener({
      cameraProvider = providerFuture.get()
      bindCamera(lifecycleOwner)
    }, ContextCompat.getMainExecutor(context))
  }

  private fun bindCamera(lifecycleOwner: LifecycleOwner) {
    val provider = cameraProvider ?: return

    val selector = CameraSelector.DEFAULT_FRONT_CAMERA

    val preview = Preview.Builder()
      .setTargetRotation(previewView.display?.rotation ?: display.rotation)
      .setMirrorMode(MirrorMode.MIRROR_MODE_ON_FRONT_ONLY)
      .build()
      .also {
        it.setSurfaceProvider(previewView.surfaceProvider)
      }

    val analysis = ImageAnalysis.Builder()
      .setTargetRotation(previewView.display?.rotation ?: display.rotation)
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .build()
      .also {
        it.setAnalyzer(analysisExecutor, ::analyzeFrame)
      }

    provider.unbind(previewUseCase, analysisUseCase)
    provider.bindToLifecycle(lifecycleOwner, selector, preview, analysis)

    previewUseCase = preview
    analysisUseCase = analysis
  }

  private fun analyzeFrame(imageProxy: ImageProxy) {
    val mediaImage = imageProxy.image
    val landmarker = handLandmarker

    if (mediaImage == null || landmarker == null) {
      imageProxy.close()
      return
    }

    try {
      val sourceTransform = transformFactory.getOutputTransform(imageProxy)
      val previewTransform = previewView.outputTransform

      if (sourceTransform != null && previewTransform != null) {
        latestCoordinateTransform = CoordinateTransform(sourceTransform, previewTransform)
        latestImageRotation = imageProxy.imageInfo.rotationDegrees
        latestImageWidth = if (latestImageRotation == 90 || latestImageRotation == 270) {
          imageProxy.height
        } else {
          imageProxy.width
        }
        latestImageHeight = if (latestImageRotation == 90 || latestImageRotation == 270) {
          imageProxy.width
        } else {
          imageProxy.height
        }
      }

      val mpImage: MPImage = MediaImageBuilder(mediaImage)
        .setRotationDegrees(imageProxy.imageInfo.rotationDegrees)
        .build()

      landmarker.detectAsync(mpImage, imageProxy.imageInfo.timestamp / 1_000_000L)
    } catch (error: Throwable) {
      Log.e(TAG, "Failed to analyze camera frame", error)
      emitNoHand()
    } finally {
      imageProxy.close()
    }
  }

  private fun handleLandmarkerResult(result: HandLandmarkerResult, unusedInput: MPImage) {
    val hand = result.landmarks().firstOrNull()
    val transform = latestCoordinateTransform
    val imageWidth = latestImageWidth
    val imageHeight = latestImageHeight
    val previewWidth = previewView.width
    val previewHeight = previewView.height

    if (
      hand == null ||
      transform == null ||
      imageWidth <= 0 ||
      imageHeight <= 0 ||
      previewWidth <= 0 ||
      previewHeight <= 0
    ) {
      emitNoHand()
      return
    }

    // Android coordinate contract:
    // MediaPipe returns landmarks normalized in the analyzed, rotation-corrected
    // image. CameraX maps those image-space pixels into PreviewView pixels using
    // the same transform as the visible FILL_CENTER preview. The Preview use case
    // is mirrored for the front camera, so JS receives selfie-mirrored,
    // visible-preview-normalized x/y coordinates with a top-left origin.
    val landmarks = hand.map { landmark ->
      val point = floatArrayOf(
        landmark.x() * imageWidth,
        landmark.y() * imageHeight
      )
      transform.mapPoints(point)

      HandLandmarkRecord(
        x = (point[0] / previewWidth).toDouble(),
        y = (point[1] / previewHeight).toDouble(),
        confidence = landmark.presence().orElse(1.0f).toDouble()
      )
    }

    post {
      onHandLandmarks(HandLandmarkEvent(detected = true, landmarks = landmarks))
    }
  }

  private fun emitNoHand() {
    post {
      onHandLandmarks(HandLandmarkEvent(detected = false, landmarks = emptyList()))
    }
  }

  private fun stopCamera() {
    cameraProvider?.unbind(previewUseCase, analysisUseCase)
    previewUseCase = null
    analysisUseCase = null
  }

  fun destroy() {
    stopCamera()
    handLandmarker?.close()
    handLandmarker = null
    analysisExecutor.shutdown()
  }
}
