import { useCallback, useEffect, useRef, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Image,
  ScrollView,
  TouchableOpacity,
  useWindowDimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import {
  GestureHandlerRootView,
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import {
  HandTrackerView,
  type HandTrackerViewRef,
  type HandLandmark,
  type HandLandmarksPayload,
} from '../../modules/hand-tracker';
import { useTrackingQuality, type TrackingQualityStatus } from '../../utils/trackingQuality';
import { saveCalibration, type CalibrationData } from '../../utils/calibration';

// ISO 7810 ID-1 card dimensions (bank card / credit card).
const CARD_WIDTH_MM = 85.6;
const CARD_HEIGHT_MM = 53.98;
const CARD_ASPECT_RATIO = CARD_WIDTH_MM / CARD_HEIGHT_MM; // ≈1.586

const REQUIRED_LANDMARKS = [0, 5, 9, 17] as const;
const MIN_CONFIDENCE = 0.5;
const MIN_PLAUSIBLE_MM = 50;
const MAX_PLAUSIBLE_MM = 130;

const INITIAL_OUTLINE_WIDTH = 180;
const MIN_OUTLINE_WIDTH = 80;
const HANDLE_SIZE = 28;
const ROTATE_HANDLE_SIZE = 28;
const ROTATE_HANDLE_GAP = 28;

const REMINDER_TEXT = 'Keep the card and your palm the same distance from the camera';
const COUNTDOWN_SECONDS = 5;

type FrameFailureReason = 'no-hand' | 'low-confidence' | 'not-tracking';

const FRAME_FAILURE_MESSAGES: Record<FrameFailureReason, string> = {
  'no-hand': 'No hand detected — make sure your hand is fully visible in frame',
  'low-confidence':
    "Couldn't see your hand clearly — try better lighting or move your hand closer",
  'not-tracking': 'Still focusing — hold still for a moment and try again',
};
const SNAPSHOT_FAILED_MESSAGE = "Couldn't take the photo — try again";
const SAVE_FAILED_MESSAGE = "Couldn't save your calibration — try again";

type ResultFailureReason = 'implausible-length';

const RESULT_FAILURE_MESSAGES: Record<ResultFailureReason, string> = {
  // Adapted from this app's earlier cross-capture mismatch message, now
  // applied to a single reading — the underlying causes are the same.
  'implausible-length':
    "That measurement didn't look right. This usually means the card and your palm weren't " +
    "the same distance from the camera, or the box wasn't fitted accurately to the card. " +
    "Let's try again.",
};

type Phase = 'intro' | 'ready' | 'countdown' | 'fitting' | 'review' | 'error' | 'success';

type CaptureResult = {
  palmLengthMm: number;
  widthToLengthRatio: number;
  handedness: 'left' | 'right';
};

type FrozenFrame = {
  imageUri: string;
  landmarks: HandLandmark[];
  viewWidth: number;
  viewHeight: number;
};

function validateFrame(
  payload: HandLandmarksPayload,
  status: TrackingQualityStatus,
): FrameFailureReason | null {
  if (!payload.detected || payload.landmarks.length !== 21) return 'no-hand';
  if (REQUIRED_LANDMARKS.some((i) => payload.landmarks[i].confidence < MIN_CONFIDENCE)) {
    return 'low-confidence';
  }
  if (status !== 'good') return 'not-tracking';
  return null;
}

function computeCaptureResult(
  landmarks: HandLandmark[],
  viewWidth: number,
  viewHeight: number,
  outlineWidthPoints: number,
): CaptureResult {
  const toPoint = (i: number) => ({ x: landmarks[i].x * viewWidth, y: landmarks[i].y * viewHeight });
  const wrist = toPoint(0);
  const indexMcp = toPoint(5);
  const middleMcp = toPoint(9);
  const pinkyMcp = toPoint(17);

  const palmLengthPixels = Math.hypot(middleMcp.x - wrist.x, middleMcp.y - wrist.y);
  const palmWidthPixels = Math.hypot(pinkyMcp.x - indexMcp.x, pinkyMcp.y - indexMcp.y);

  const pixelsPerMm = outlineWidthPoints / CARD_WIDTH_MM;
  const palmLengthMm = palmLengthPixels / pixelsPerMm;
  const widthToLengthRatio = palmWidthPixels / palmLengthPixels;

  // Handedness: sign of the 2D cross product of vector(wrist→indexMcp) and
  // vector(wrist→pinkyMcp). With the preview already selfie-mirrored (see
  // hand-tracker coordinate contract) and the palm held facing the camera,
  // this sign convention was chosen as: positive cross product => right hand,
  // negative => left hand. Verify against a real hand and flip if backwards.
  const v1x = indexMcp.x - wrist.x;
  const v1y = indexMcp.y - wrist.y;
  const v2x = pinkyMcp.x - wrist.x;
  const v2y = pinkyMcp.y - wrist.y;
  const cross = v1x * v2y - v1y * v2x;
  const handedness: 'left' | 'right' = cross > 0 ? 'right' : 'left';

  return { palmLengthMm, widthToLengthRatio, handedness };
}

function validateResult(result: CaptureResult): ResultFailureReason | null {
  if (result.palmLengthMm < MIN_PLAUSIBLE_MM || result.palmLengthMm > MAX_PLAUSIBLE_MM) {
    return 'implausible-length';
  }
  return null;
}

// Rotates a point (given relative to some origin) by angleRad.
function rotatePoint(x: number, y: number, angleRad: number): { x: number; y: number } {
  'worklet';
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

// Keeps a rotated rectangle's center within the container by clamping against
// its rotated axis-aligned bounding box, not its own (unrotated) width/height
// — a tilted rectangle's on-screen footprint is larger than w×h.
function clampCenterToBounds(
  cx: number,
  cy: number,
  width: number,
  height: number,
  angleRad: number,
  containerWidth: number,
  containerHeight: number,
): { x: number; y: number } {
  'worklet';
  const cos = Math.abs(Math.cos(angleRad));
  const sin = Math.abs(Math.sin(angleRad));
  const halfBoundW = (width * cos + height * sin) / 2;
  const halfBoundH = (width * sin + height * cos) / 2;
  const x =
    halfBoundW * 2 <= containerWidth
      ? Math.min(Math.max(cx, halfBoundW), containerWidth - halfBoundW)
      : containerWidth / 2;
  const y =
    halfBoundH * 2 <= containerHeight
      ? Math.min(Math.max(cy, halfBoundH), containerHeight - halfBoundH)
      : containerHeight / 2;
  return { x, y };
}

export default function CalibrationScreen() {
  const router = useRouter();
  const isFocused = useIsFocused();
  const { width: windowWidth } = useWindowDimensions();
  const maxOutlineWidth = windowWidth - 40;

  const { status: trackingStatus, reportFrame } = useTrackingQuality();

  const [phase, setPhase] = useState<Phase>('intro');
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [frozenFrame, setFrozenFrame] = useState<FrozenFrame | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [successData, setSuccessData] = useState<{ palmLengthMm: number; handedness: 'left' | 'right' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);

  const statusRef = useRef<TrackingQualityStatus>(trackingStatus);
  useEffect(() => {
    statusRef.current = trackingStatus;
  }, [trackingStatus]);

  const latestFrameRef = useRef<HandLandmarksPayload>({ detected: false, landmarks: [] });
  const handTrackerRef = useRef<HandTrackerViewRef>(null);

  // Container dimensions, shared with UI-thread worklets for drag/resize/rotate clamping.
  const containerSize = useSharedValue({ width: 0, height: 0 });

  // Outline modeled as center + width + rotation angle (degrees), rather than
  // top-left + width, since rotation is naturally expressed around a center.
  const centerX = useSharedValue(0);
  const centerY = useSharedValue(0);
  const outlineWidth = useSharedValue(INITIAL_OUTLINE_WIDTH);
  const angle = useSharedValue(0);

  const savedCenterX = useSharedValue(0);
  const savedCenterY = useSharedValue(0);
  const savedWidth = useSharedValue(INITIAL_OUTLINE_WIDTH);
  const savedAngle = useSharedValue(0);

  const resetOutline = useCallback(() => {
    const size = containerSize.value;
    const width = INITIAL_OUTLINE_WIDTH;
    const cx = size.width / 2;
    const cy = size.height / 2;
    centerX.value = cx;
    centerY.value = cy;
    outlineWidth.value = width;
    angle.value = 0;
    savedCenterX.value = cx;
    savedCenterY.value = cy;
    savedWidth.value = width;
    savedAngle.value = 0;
  }, [containerSize, centerX, centerY, outlineWidth, angle, savedCenterX, savedCenterY, savedWidth, savedAngle]);

  // Drag anywhere on the outline body to move it.
  const movePan = Gesture.Pan()
    .maxPointers(1)
    .onUpdate((e) => {
      const w = outlineWidth.value;
      const h = w / CARD_ASPECT_RATIO;
      const angleRad = (angle.value * Math.PI) / 180;
      const rawX = savedCenterX.value + e.translationX;
      const rawY = savedCenterY.value + e.translationY;
      const clamped = clampCenterToBounds(
        rawX, rawY, w, h, angleRad,
        containerSize.value.width, containerSize.value.height,
      );
      centerX.value = clamped.x;
      centerY.value = clamped.y;
    })
    .onEnd(() => {
      savedCenterX.value = centerX.value;
      savedCenterY.value = centerY.value;
    });

  // Corner handle resizes along the box's OWN rotated axis (not screen axes),
  // anchored at the opposite (local top-left) corner so it grows away from it
  // exactly like the original axis-aligned behavior did.
  const resizePan = Gesture.Pan()
    .maxPointers(1)
    .onUpdate((e) => {
      const angleRad = (savedAngle.value * Math.PI) / 180;
      const localDelta = e.translationX * Math.cos(angleRad) + e.translationY * Math.sin(angleRad);
      const newWidth = Math.min(Math.max(savedWidth.value + localDelta, MIN_OUTLINE_WIDTH), maxOutlineWidth);
      const newHeight = newWidth / CARD_ASPECT_RATIO;
      const savedHeight = savedWidth.value / CARD_ASPECT_RATIO;

      const anchorOffset = rotatePoint(-savedWidth.value / 2, -savedHeight / 2, angleRad);
      const anchorScreenX = savedCenterX.value + anchorOffset.x;
      const anchorScreenY = savedCenterY.value + anchorOffset.y;

      const newAnchorOffset = rotatePoint(-newWidth / 2, -newHeight / 2, angleRad);
      const rawX = anchorScreenX - newAnchorOffset.x;
      const rawY = anchorScreenY - newAnchorOffset.y;

      const clamped = clampCenterToBounds(
        rawX, rawY, newWidth, newHeight, angleRad,
        containerSize.value.width, containerSize.value.height,
      );

      outlineWidth.value = newWidth;
      centerX.value = clamped.x;
      centerY.value = clamped.y;
    })
    .onEnd(() => {
      savedWidth.value = outlineWidth.value;
      savedCenterX.value = centerX.value;
      savedCenterY.value = centerY.value;
    });

  // Rotation handle sits above the box's top edge and rotates with it. Dragging
  // it recomputes the angle from the vector between the box's center (fixed
  // during pure rotation) and the handle's current position.
  const rotatePan = Gesture.Pan()
    .maxPointers(1)
    .onUpdate((e) => {
      const w = savedWidth.value;
      const h = w / CARD_ASPECT_RATIO;
      const startAngleRad = (savedAngle.value * Math.PI) / 180;
      const localAnchor = rotatePoint(0, -h / 2 - ROTATE_HANDLE_GAP, startAngleRad);
      const handleStartX = savedCenterX.value + localAnchor.x;
      const handleStartY = savedCenterY.value + localAnchor.y;
      const handleCurrentX = handleStartX + e.translationX;
      const handleCurrentY = handleStartY + e.translationY;

      const vx = handleCurrentX - centerX.value;
      const vy = handleCurrentY - centerY.value;
      const newAngleRad = Math.atan2(vy, vx) + Math.PI / 2;
      const newAngleDeg = (newAngleRad * 180) / Math.PI;

      const clamped = clampCenterToBounds(
        centerX.value, centerY.value, w, h, newAngleRad,
        containerSize.value.width, containerSize.value.height,
      );

      angle.value = newAngleDeg;
      centerX.value = clamped.x;
      centerY.value = clamped.y;
    })
    .onEnd(() => {
      savedAngle.value = angle.value;
      savedCenterX.value = centerX.value;
      savedCenterY.value = centerY.value;
    });

  const outlineStyle = useAnimatedStyle(() => {
    const w = outlineWidth.value;
    const h = w / CARD_ASPECT_RATIO;
    return {
      left: centerX.value - w / 2,
      top: centerY.value - h / 2,
      width: w,
      height: h,
      transform: [{ rotate: `${angle.value}deg` }],
    };
  });

  const resizeHandleStyle = useAnimatedStyle(() => {
    const w = outlineWidth.value;
    const h = w / CARD_ASPECT_RATIO;
    const angleRad = (angle.value * Math.PI) / 180;
    const offset = rotatePoint(w / 2, h / 2, angleRad);
    return {
      left: centerX.value + offset.x - HANDLE_SIZE / 2,
      top: centerY.value + offset.y - HANDLE_SIZE / 2,
    };
  });

  const rotateHandleStyle = useAnimatedStyle(() => {
    const w = outlineWidth.value;
    const h = w / CARD_ASPECT_RATIO;
    const angleRad = (angle.value * Math.PI) / 180;
    const offset = rotatePoint(0, -h / 2 - ROTATE_HANDLE_GAP, angleRad);
    return {
      left: centerX.value + offset.x - ROTATE_HANDLE_SIZE / 2,
      top: centerY.value + offset.y - ROTATE_HANDLE_SIZE / 2,
    };
  });

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      containerSize.value = { width, height };
    },
    [containerSize],
  );

  const handleLandmarks = useCallback(
    (event: { nativeEvent: HandLandmarksPayload }) => {
      const payload = event.nativeEvent;
      reportFrame(payload);
      latestFrameRef.current = payload;
    },
    [reportFrame],
  );

  // Runs at the moment the countdown reaches zero — the frame is validated
  // here, not at the initial button tap, since the patient isn't positioned
  // yet when they tap "Capture" to start the countdown.
  //
  // The still image comes from the native takeSnapshot() method, which is
  // cropped/mirrored on the native side to match the live preview exactly, so
  // its pixels align with the landmarks captured from the same moment.
  const performCapture = useCallback(async () => {
    const payload = latestFrameRef.current;

    const failureReason = validateFrame(payload, statusRef.current);
    if (failureReason) {
      setErrorMessage(FRAME_FAILURE_MESSAGES[failureReason]);
      setPhase('error');
      setCountdown(null);
      return;
    }

    try {
      const imageUri = await handTrackerRef.current?.takeSnapshot();
      if (!imageUri) {
        throw new Error('Snapshot unavailable');
      }

      const size = containerSize.value;
      resetOutline();
      setFrozenFrame({
        imageUri,
        landmarks: payload.landmarks,
        viewWidth: size.width,
        viewHeight: size.height,
      });
      setPhase('fitting');
    } catch {
      setErrorMessage(SNAPSHOT_FAILED_MESSAGE);
      setPhase('error');
    } finally {
      setCountdown(null);
    }
  }, [containerSize, resetOutline]);

  const startCountdown = useCallback(() => {
    setCountdown(COUNTDOWN_SECONDS);
    setPhase('countdown');
  }, []);

  // Ticks the countdown once per second with a haptic pulse, then fires the
  // capture automatically at zero — no further interaction from the patient.
  useEffect(() => {
    if (phase !== 'countdown' || countdown === null) return undefined;

    if (countdown <= 0) {
      performCapture();
      return undefined;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});

    const timer = setTimeout(() => {
      setCountdown((c) => (c ?? 1) - 1);
    }, 1000);

    return () => clearTimeout(timer);
  }, [phase, countdown, performCapture]);

  const handleStart = useCallback(() => {
    setPhase('ready');
  }, []);

  const handleConfirmFit = useCallback(() => {
    if (!frozenFrame) return;
    const computed = computeCaptureResult(
      frozenFrame.landmarks,
      frozenFrame.viewWidth,
      frozenFrame.viewHeight,
      outlineWidth.value,
    );
    setFrozenFrame(null);

    const failureReason = validateResult(computed);
    if (failureReason) {
      setErrorMessage(RESULT_FAILURE_MESSAGES[failureReason]);
      setPhase('error');
      return;
    }

    setResult(computed);
    setPhase('review');
  }, [frozenFrame, outlineWidth]);

  const handleRetakeFromReview = useCallback(() => {
    setResult(null);
    setPhase('ready');
  }, []);

  const handleConfirmResult = useCallback(async () => {
    if (!result) return;

    const data: CalibrationData = {
      palmLengthMm: result.palmLengthMm,
      widthToLengthRatio: result.widthToLengthRatio,
      handedness: result.handedness,
      capturedAt: new Date().toISOString(),
      version: 1,
    };

    setBusy(true);
    try {
      await saveCalibration(data);
      setSuccessData({ palmLengthMm: result.palmLengthMm, handedness: result.handedness });
      setPhase('success');
    } catch {
      setErrorMessage(SAVE_FAILED_MESSAGE);
      setPhase('error');
    } finally {
      setBusy(false);
    }
  }, [result]);

  const handleRetry = useCallback(() => {
    setResult(null);
    setPhase('ready');
  }, []);

  return (
    <GestureHandlerRootView style={styles.flex}>
      <View style={styles.container} onLayout={handleLayout}>
        {/* index.tsx's tab stays mounted underneath this screen (same Tabs
            navigator), so its own camera session must release the device
            here too, symmetrically, for the round trip back to work. */}
        {isFocused && (
          <HandTrackerView
            ref={handTrackerRef}
            style={StyleSheet.absoluteFill}
            onHandLandmarks={handleLandmarks}
          />
        )}

        {phase === 'intro' && (
          <View style={styles.introContainer}>
            <ScrollView contentContainerStyle={styles.introScrollContent}>
              <Text style={styles.introTitle}>Measuring your hand</Text>
              <Text style={styles.introParagraph}>
                The app needs to know how big your hand is, so it can measure your progress in
                real millimetres.
              </Text>
              <Text style={styles.introParagraph}>
                You'll take a photo of your hand next to a bank card. The card is a standard
                size, so it tells the app how to convert what the camera sees into real
                measurements.
              </Text>
              <Text style={styles.introSubheading}>What you'll need to do:</Text>
              <View style={styles.introBulletList}>
                <Text style={styles.introBullet}>
                  •  Prop your phone against something so both hands are free
                </Text>
                <Text style={styles.introBullet}>
                  •  Hold a bank card in one hand, and open your other hand flat beside it
                </Text>
                <Text style={styles.introBullet}>
                  •  Keep the card and your open hand the same distance from the camera
                </Text>
              </View>
              <Text style={styles.introParagraph}>
                After the photo you'll drag a box onto the card so the app knows exactly how big
                it appears.
              </Text>
            </ScrollView>
            <TouchableOpacity style={[styles.button, styles.introStartButton]} onPress={handleStart}>
              <Text style={styles.buttonText}>Start</Text>
            </TouchableOpacity>
          </View>
        )}

        {phase === 'fitting' && frozenFrame && (
          <>
            <Image
              source={{ uri: frozenFrame.imageUri }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
            />

            <GestureDetector gesture={movePan}>
              <Animated.View style={[styles.outline, outlineStyle]} />
            </GestureDetector>
            <GestureDetector gesture={resizePan}>
              <Animated.View style={[styles.handle, resizeHandleStyle]} />
            </GestureDetector>
            <GestureDetector gesture={rotatePan}>
              <Animated.View style={[styles.rotateHandle, rotateHandleStyle]} />
            </GestureDetector>

            <View style={styles.header} pointerEvents="none">
              <Text style={styles.secondaryText}>
                Drag, resize, and rotate the outline to match your card
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.button, styles.confirmButton, busy && styles.buttonDisabled]}
              onPress={handleConfirmFit}
              disabled={busy}
            >
              <Text style={styles.buttonText}>Confirm</Text>
            </TouchableOpacity>
          </>
        )}

        {phase === 'ready' && (
          <>
            <View style={styles.header} pointerEvents="none">
              <Text style={styles.reminderText}>{REMINDER_TEXT}</Text>
            </View>

            <TouchableOpacity
              style={[styles.button, styles.confirmButton, busy && styles.buttonDisabled]}
              onPress={startCountdown}
              disabled={busy}
            >
              <Text style={styles.buttonText}>Capture</Text>
            </TouchableOpacity>
          </>
        )}

        {phase === 'countdown' && countdown !== null && (
          <View style={styles.countdownOverlay} pointerEvents="none">
            <View style={styles.header}>
              <Text style={styles.reminderText}>{REMINDER_TEXT}</Text>
            </View>
            <View style={styles.countdownCircle}>
              <Text style={styles.countdownNumber}>{countdown > 0 ? countdown : '•'}</Text>
            </View>
            <Text style={styles.secondaryText}>Hold still…</Text>
          </View>
        )}

        {phase === 'review' && result && (
          <View style={styles.messageBox}>
            <Text style={styles.successTitle}>Review your capture</Text>
            <Text style={styles.messageText}>
              Palm length: {Math.round(result.palmLengthMm)}mm
            </Text>
            <Text style={styles.messageText}>
              {result.handedness === 'right' ? 'Right hand' : 'Left hand'}
            </Text>
            <TouchableOpacity style={styles.button} onPress={handleRetakeFromReview}>
              <Text style={styles.buttonText}>Retake</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.continueButton, busy && styles.buttonDisabled]}
              onPress={handleConfirmResult}
              disabled={busy}
            >
              <Text style={styles.buttonText}>{busy ? 'Saving…' : 'Looks good'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {phase === 'error' && (
          <View style={styles.messageBox}>
            <Text style={styles.messageText}>{errorMessage}</Text>
            <TouchableOpacity style={styles.button} onPress={handleRetry}>
              <Text style={styles.buttonText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        )}

        {phase === 'success' && successData && (
          <View style={styles.messageBox}>
            <Text style={styles.successTitle}>Calibration complete</Text>
            <Text style={styles.messageText}>
              Palm length: {Math.round(successData.palmLengthMm)}mm
            </Text>
            <Text style={styles.messageText}>
              {successData.handedness === 'right' ? 'Right hand' : 'Left hand'}
            </Text>
            <TouchableOpacity style={styles.button} onPress={() => router.back()}>
              <Text style={styles.buttonText}>Done</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    position: 'absolute',
    top: 64,
    left: 24,
    right: 24,
    alignItems: 'center',
  },
  secondaryText: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 13,
    textAlign: 'center',
  },
  reminderText: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 12,
    textAlign: 'center',
  },
  countdownOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  countdownCircle: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 3,
    borderColor: '#00FF88',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countdownNumber: {
    color: '#fff',
    fontSize: 88,
    fontWeight: '800',
  },
  outline: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: '#00FF88',
    borderStyle: 'dashed',
    borderRadius: 10,
  },
  handle: {
    position: 'absolute',
    width: HANDLE_SIZE,
    height: HANDLE_SIZE,
    borderRadius: HANDLE_SIZE / 2,
    backgroundColor: '#00FF88',
  },
  rotateHandle: {
    position: 'absolute',
    width: ROTATE_HANDLE_SIZE,
    height: ROTATE_HANDLE_SIZE,
    borderRadius: ROTATE_HANDLE_SIZE / 2,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#00FF88',
  },
  messageBox: {
    position: 'absolute',
    bottom: 140,
    left: 24,
    right: 24,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 16,
    alignItems: 'center',
  },
  successTitle: {
    color: '#00FF88',
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  messageText: {
    color: '#fff',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 4,
  },
  button: {
    marginTop: 10,
    borderWidth: 1.5,
    borderColor: '#00FF88',
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonText: {
    color: '#00FF88',
    fontSize: 16,
    fontWeight: '600',
  },
  confirmButton: {
    position: 'absolute',
    bottom: 48,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  continueButton: {
    backgroundColor: 'rgba(0,180,90,0.25)',
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  introContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000',
    paddingTop: 72,
    paddingBottom: 24,
    paddingHorizontal: 24,
  },
  introScrollContent: {
    paddingBottom: 24,
  },
  introTitle: {
    color: '#00FF88',
    fontSize: 22,
    fontWeight: '800',
    marginBottom: 16,
    textAlign: 'center',
  },
  introParagraph: {
    color: '#fff',
    fontSize: 15,
    lineHeight: 21,
    marginBottom: 14,
  },
  introSubheading: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 8,
  },
  introBulletList: {
    marginBottom: 14,
  },
  introBullet: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 6,
  },
  introStartButton: {
    alignSelf: 'stretch',
  },
});
