import { useCallback } from 'react';
import { StyleSheet, View, Text, Dimensions, TouchableOpacity } from 'react-native';
import { useCameraPermissions } from 'expo-camera';
import Animated, {
  useSharedValue,
  useAnimatedProps,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Path, Circle } from 'react-native-svg';
import {
  HandTrackerView,
  type HandLandmark,
  type HandLandmarksPayload,
} from '../../modules/hand-tracker';

const { width: W, height: H } = Dimensions.get('window');

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

// ─── Animated SVG primitives ──────────────────────────────────────────────────

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// One component per landmark so useAnimatedProps is called at component level
// (not inside a loop), satisfying Rules of Hooks.
function LandmarkDot({
  index,
  pts,
}: {
  index: number;
  pts: SharedValue<HandLandmark[]>;
}) {
  const isTip = FINGERTIP_SET.includes(index);
  const props = useAnimatedProps(() => {
    'worklet';
    const l = pts.value[index];
    if (!l || l.confidence < 0.25) return { cx: -50, cy: -50, r: 0 };
    return { cx: l.x * W, cy: l.y * H, r: isTip ? 7 : 4 };
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
function SkeletonLines({ pts }: { pts: SharedValue<HandLandmark[]> }) {
  const props = useAnimatedProps(() => {
    'worklet';
    const l = pts.value;
    let d = '';
    for (let i = 0; i < CONNECTIONS.length; i++) {
      const si = CONNECTIONS[i][0];
      const ei = CONNECTIONS[i][1];
      const s = l[si];
      const e = l[ei];
      if (s && e && s.confidence > 0.25 && e.confidence > 0.25) {
        d += `M${s.x * W},${s.y * H}L${e.x * W},${e.y * H}`;
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

function SkeletonOverlay({ pts }: { pts: SharedValue<HandLandmark[]> }) {
  return (
    <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
      <SkeletonLines pts={pts} />
      {Array.from({ length: 21 }, (_, i) => (
        <LandmarkDot key={i} index={i} pts={pts} />
      ))}
    </Svg>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const pts = useSharedValue<HandLandmark[]>(EMPTY);

  const handleLandmarks = useCallback(
    (event: { nativeEvent: HandLandmarksPayload }) => {
      const { detected, landmarks } = event.nativeEvent;
      // Direct shared value assignment — schedules UI-thread update, no re-render
      pts.value = detected && landmarks.length === 21 ? landmarks : EMPTY;
    },
    [pts],
  );

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
    <View style={styles.container}>
      <HandTrackerView
        style={StyleSheet.absoluteFill}
        onHandLandmarks={handleLandmarks}
      />
      <SkeletonOverlay pts={pts} />
      <View style={styles.badge}>
        <Text style={styles.badgeText}>Show your hand</Text>
      </View>
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
