package expo.modules.handtracker

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Color
import android.util.Log
import android.view.Surface
import android.view.View
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
private const val USE_COMPATIBLE_PREVIEW_MODE = true

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
    // Bright red is intentional while debugging Android composition. If red is
    // not visible before CameraX draws, the native child view is not visible in
    // the React Native/Expo hierarchy. If red is visible but camera is black,
    // the issue is the CameraX PreviewView surface path.
    setBackgroundColor(Color.RED)
    implementationMode = if (USE_COMPATIBLE_PREVIEW_MODE) {
      PreviewView.ImplementationMode.COMPATIBLE
    } else {
      PreviewView.ImplementationMode.PERFORMANCE
    }
    scaleType = PreviewView.ScaleType.FILL_CENTER
    alpha = 1f
    visibility = View.VISIBLE
    z = 0f
    translationZ = 0f
    elevation = 0f
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
  private var isCameraBound = false

  init {
    setBackgroundColor(Color.TRANSPARENT)
    clipChildren = false
    clipToPadding = false
    addView(previewView)
    ensurePreviewViewVisible()
    Log.d(TAG, "PreviewView added to HandTrackerView. childCount=$childCount mode=${previewView.implementationMode}")
    logPreviewViewState("init")
    setupHandLandmarker()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    Log.d(TAG, "HandTrackerView attached. view=${width}x$height preview=${previewView.width}x${previewView.height}")
    ensurePreviewViewVisible()
    logPreviewViewState("attached")
    post {
      startCameraIfPermitted()
    }
  }

  override fun onDetachedFromWindow() {
    Log.d(TAG, "HandTrackerView detached")
    stopCamera()
    super.onDetachedFromWindow()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)

    previewView.measure(
      MeasureSpec.makeMeasureSpec(measuredWidth, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(measuredHeight, MeasureSpec.EXACTLY)
    )
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    val width = right - left
    val height = bottom - top
    previewView.layout(0, 0, width, height)
    ensurePreviewViewVisible()

    if (changed) {
      logPreviewViewState("layout")
      if (isAttachedToWindow && !isCameraBound) {
        post {
          startCameraIfPermitted()
        }
      }
    }
  }

  private fun setupHandLandmarker() {
    try {
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
      Log.d(TAG, "MediaPipe HandLandmarker created")
    } catch (error: Throwable) {
      Log.e(TAG, "Failed to create MediaPipe HandLandmarker", error)
      emitNoHand()
    }
  }

  private fun startCameraIfPermitted() {
    Log.d(TAG, "startCameraIfPermitted called. attached=$isAttachedToWindow size=${width}x$height preview=${previewView.width}x${previewView.height}")
    ensurePreviewViewVisible()
    logPreviewViewState("startCameraIfPermitted")

    if (isCameraBound) {
      Log.d(TAG, "CameraX is already bound; skipping duplicate start")
      return
    }

    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      // The React screen already requests camera permission via expo-camera.
      // Native Android only starts CameraX after that permission is granted.
      Log.w(TAG, "CAMERA permission is not granted; CameraX preview will not start")
      emitNoHand()
      return
    }

    val lifecycleOwner = appContext.throwingActivity as? LifecycleOwner ?: run {
      Log.e(TAG, "Current activity is not a LifecycleOwner; cannot bind CameraX")
      emitNoHand()
      return
    }

    Log.d(TAG, "Requesting ProcessCameraProvider")
    val providerFuture = ProcessCameraProvider.getInstance(context)
    providerFuture.addListener({
      try {
        cameraProvider = providerFuture.get()
        Log.d(TAG, "ProcessCameraProvider ready")
        bindCamera(lifecycleOwner)
      } catch (error: Throwable) {
        Log.e(TAG, "Failed to obtain ProcessCameraProvider", error)
        emitNoHand()
      }
    }, ContextCompat.getMainExecutor(context))
  }

  private fun bindCamera(lifecycleOwner: LifecycleOwner) {
    val provider = cameraProvider ?: return

    if (previewView.width <= 0 || previewView.height <= 0) {
      Log.w(TAG, "PreviewView has no size yet; delaying CameraX bind")
      previewView.post {
        bindCamera(lifecycleOwner)
      }
      return
    }

    val selector = CameraSelector.DEFAULT_FRONT_CAMERA
    val targetRotation = previewView.display?.rotation ?: display?.rotation ?: Surface.ROTATION_0

    try {
      ensurePreviewViewVisible()
      logPreviewViewState("bindCamera-before")

      val availableCameraInfos = provider.availableCameraInfos
      val frontCameraInfos = selector.filter(availableCameraInfos)
      val hasFrontCamera = provider.hasCamera(selector)
      Log.d(
        TAG,
        "CameraX cameras: available=${availableCameraInfos.size} frontMatches=${frontCameraInfos.size} " +
          "hasFrontCamera=$hasFrontCamera selectedLensFacing=${lensFacingName(CameraSelector.LENS_FACING_FRONT)}"
      )
      frontCameraInfos.forEachIndexed { index, cameraInfo ->
        Log.d(TAG, "Front camera candidate #$index lensFacing=${lensFacingName(cameraInfo.lensFacing)}")
      }

      Log.d(
        TAG,
        "Binding CameraX. targetRotation=$targetRotation previewSize=${previewView.width}x${previewView.height}"
      )

      val previewSurfaceProvider = previewView.surfaceProvider
      val preview = Preview.Builder()
        .setTargetRotation(targetRotation)
        .setMirrorMode(MirrorMode.MIRROR_MODE_ON_FRONT_ONLY)
        .build()
        .also {
          Log.d(
            TAG,
            "Attaching Preview surface provider after attach=${previewView.isAttachedToWindow} " +
              "previewSize=${previewView.width}x${previewView.height} mode=${previewView.implementationMode}"
          )
          it.setSurfaceProvider { surfaceRequest ->
            Log.d(
              TAG,
              "Surface requested by Preview. resolution=${surfaceRequest.resolution} " +
                "attached=${previewView.isAttachedToWindow} visibility=${visibilityName(previewView.visibility)}"
            )
            previewSurfaceProvider.onSurfaceRequested(surfaceRequest)
          }
        }

      val analysis = ImageAnalysis.Builder()
        .setTargetRotation(targetRotation)
        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        .build()
        .also {
          it.setAnalyzer(analysisExecutor, ::analyzeFrame)
        }

      provider.unbind(previewUseCase, analysisUseCase)
      val camera = provider.bindToLifecycle(lifecycleOwner, selector, preview, analysis)

      previewUseCase = preview
      analysisUseCase = analysis
      isCameraBound = true
      Log.d(TAG, "CameraX bindToLifecycle succeeded. boundLensFacing=${lensFacingName(camera.cameraInfo.lensFacing)}")
      camera.cameraInfo.cameraState.observe(lifecycleOwner) { cameraState ->
        Log.d(TAG, "Camera state changed: type=${cameraState.type} error=${cameraState.error}")
      }
      previewView.previewStreamState.observe(lifecycleOwner) { streamState ->
        Log.d(TAG, "Preview stream state changed: $streamState")
      }
      logPreviewViewState("bindCamera-after")
    } catch (error: Throwable) {
      Log.e(TAG, "CameraX bindToLifecycle failed", error)
      isCameraBound = false
      emitNoHand()
    }
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

  private fun ensurePreviewViewVisible() {
    previewView.visibility = View.VISIBLE
    previewView.alpha = 1f
    previewView.z = 0f
    previewView.translationZ = 0f
    previewView.elevation = 0f
  }

  private fun logPreviewViewState(stage: String) {
    Log.d(
      TAG,
      "PreviewView state [$stage]: parent=${width}x$height preview=${previewView.width}x${previewView.height} " +
        "measured=${previewView.measuredWidth}x${previewView.measuredHeight} " +
        "attached=${previewView.isAttachedToWindow} visibility=${visibilityName(previewView.visibility)} " +
        "alpha=${previewView.alpha} z=${previewView.z} translationZ=${previewView.translationZ} " +
        "mode=${previewView.implementationMode}"
    )
  }

  private fun visibilityName(visibility: Int): String {
    return when (visibility) {
      View.VISIBLE -> "VISIBLE"
      View.INVISIBLE -> "INVISIBLE"
      View.GONE -> "GONE"
      else -> visibility.toString()
    }
  }

  private fun lensFacingName(lensFacing: Int?): String {
    return when (lensFacing) {
      CameraSelector.LENS_FACING_FRONT -> "FRONT"
      CameraSelector.LENS_FACING_BACK -> "BACK"
      null -> "UNKNOWN"
      else -> lensFacing.toString()
    }
  }

  private fun stopCamera() {
    Log.d(TAG, "Stopping CameraX")
    cameraProvider?.unbind(previewUseCase, analysisUseCase)
    previewUseCase = null
    analysisUseCase = null
    isCameraBound = false
  }

  fun destroy() {
    stopCamera()
    handLandmarker?.close()
    handLandmarker = null
    analysisExecutor.shutdown()
  }
}
