import { useCallback, useEffect, useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  type LayoutChangeEvent,
} from 'react-native';
import { useCameraPermissions } from 'expo-camera';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  useAnimatedStyle,
  withTiming,
  withRepeat,
  withSequence,
  cancelAnimation,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Circle } from 'react-native-svg';
import {
  HandTrackerView,
  type HandLandmark,
  type HandLandmarksPayload,
} from '../../modules/hand-tracker';
import { useTrackingQuality } from '../../utils/trackingQuality';

// All 21 MediaPipe hand connections
const CONNECTIONS: readonly [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],           // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],           // index
  [0, 9], [9, 10], [10, 11], [11, 12],      // middle
  [0, 13], [13, 14], [14, 15], [15, 16],    // ring
  [0, 17], [17, 18], [18, 19], [19, 20],    // pinky
  [5, 9], [9, 13], [13, 17],               // palm arch
] as const;

const FINGERTIP_SET = [4, 8, 12, 16, 20];

const EMPTY: HandLandmark[] = Array.from({ length: 21 }, () => ({
  x: 0, y: 0, confidence: 0,
}));

type OverlaySize = {
  width: number;
  height: number;
};

// ─── Animated SVG primitives ──────────────────────────────────────────────────

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// One component per landmark so useAnimatedProps is called at component level
// (not inside a loop), satisfying Rules of Hooks.
function LandmarkDot({
  index,
  pts,
  size,
}: {
  index: number;
  pts: SharedValue<HandLandmark[]>;
  size: SharedValue<OverlaySize>;
}) {
  const isTip = FINGERTIP_SET.includes(index);
  const props = useAnimatedProps(() => {
    'worklet';
    const l = pts.value[index];
    const layout = size.value;
    if (!l || l.confidence < 0.25 || layout.width <= 0 || layout.height <= 0) {
      return { cx: -50, cy: -50, r: 0 };
    }

    // Native emits preview-normalized coordinates after camera orientation,
    // selfie mirroring, and resizeAspectFill cropping are applied. Origin is
    // the top-left of this measured view, so rendering is just x/y * layout.
    return {
      cx: l.x * layout.width,
      cy: l.y * layout.height,
      r: isTip ? 7 : 4,
    };
  });
  return (
    <AnimatedCircle
      animatedProps={props}
      fill={isTip ? '#FF4444' : '#FFFFFF'}
      opacity={0.95}
    />
  );
}

// Single path element for every bone — one worklet, zero extra renders
function SkeletonLines({
  pts,
  size,
}: {
  pts: SharedValue<HandLandmark[]>;
  size: SharedValue<OverlaySize>;
}) {
  const props = useAnimatedProps(() => {
    'worklet';
    const l = pts.value;
    const layout = size.value;
    if (layout.width <= 0 || layout.height <= 0) return { d: '' };

    let d = '';
    for (let i = 0; i < CONNECTIONS.length; i++) {
      const si = CONNECTIONS[i][0];
      const ei = CONNECTIONS[i][1];
      const s = l[si];
      const e = l[ei];
      if (s && e && s.confidence > 0.25 && e.confidence > 0.25) {
        d += `M${s.x * layout.width},${s.y * layout.height}L${e.x * layout.width},${e.y * layout.height}`;
      }
    }
    return { d };
  });
  return (
    <AnimatedPath
      animatedProps={props}
      stroke="#00FF88"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      opacity={0.85}
    />
  );
}

function SkeletonOverlay({
  pts,
  size,
}: {
  pts: SharedValue<HandLandmark[]>;
  size: SharedValue<OverlaySize>;
}) {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <SkeletonLines pts={pts} size={size} />
      {Array.from({ length: 21 }, (_, i) => (
        <LandmarkDot key={i} index={i} pts={pts} size={size} />
      ))}
    </Svg>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const pts = useSharedValue<HandLandmark[]>(EMPTY);
  const overlaySize = useSharedValue<OverlaySize>({ width: 0, height: 0 });
  const insets = useSafeAreaInsets();
  const { status: trackingStatus, reportFrame } = useTrackingQuality();
  const [handDetected, setHandDetected] = useState(false);
  const badgePulse = useSharedValue(1);

  const handleLandmarks = useCallback(
    (event: { nativeEvent: HandLandmarksPayload }) => {
      const payload = event.nativeEvent;
      const { detected, landmarks } = payload;
      // Direct shared value assignment — schedules UI-thread update, no re-render
      pts.value = detected && landmarks.length === 21 ? landmarks : EMPTY;

      reportFrame(payload);
      setHandDetected((prev) => (prev === detected ? prev : detected));
    },
    [pts, reportFrame],
  );

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      overlaySize.value = { width, height };
    },
    [overlaySize],
  );

  useEffect(() => {
    if (handDetected) {
      cancelAnimation(badgePulse);
      badgePulse.value = withTiming(1, { duration: 150 });
    } else {
      badgePulse.value = withRepeat(
        withSequence(
          withTiming(0.5, { duration: 900 }),
          withTiming(1, { duration: 900 }),
        ),
        -1,
        true,
      );
    }
    return () => cancelAnimation(badgePulse);
  }, [handDetected, badgePulse]);

  const badgeAnimatedStyle = useAnimatedStyle(() => ({
    opacity: badgePulse.value,
  }));

  if (!permission) {
    return <View style={styles.container} />;
  }

  if (!permission.granted) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={styles.permText}>Camera permission required</Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>Grant Access</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container} onLayout={handleLayout}>
      <HandTrackerView
        style={StyleSheet.absoluteFill}
        onHandLandmarks={handleLandmarks}
      />
      <SkeletonOverlay pts={pts} size={overlaySize} />
      {trackingStatus === 'poor' && (
        <View style={[styles.banner, { paddingTop: insets.top + 8 }]}>
          <Text style={styles.bannerText}>
            Tracking is unstable — try better lighting or move your hand closer
          </Text>
        </View>
      )}
      <Animated.View style={[styles.badge, badgeAnimatedStyle]}>
        <Text style={[styles.badgeText, handDetected && styles.badgeTextDetected]}>
          {handDetected ? 'Hand detected' : 'Show your hand'}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    bottom: 48,
    alignSelf: 'center',
  },
  badgeText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    overflow: 'hidden',
  },
  badgeTextDetected: {
    backgroundColor: 'rgba(0,180,90,0.85)',
  },
  banner: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  bannerText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
  },
  permText: { color: '#fff', fontSize: 17, marginBottom: 20, textAlign: 'center' },
  permBtn: {
    borderWidth: 1.5,
    borderColor: '#00FF88',
    borderRadius: 10,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  permBtnText: { color: '#00FF88', fontSize: 16, fontWeight: '600' },
});
