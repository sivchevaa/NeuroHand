import { useCallback, useRef, useState } from 'react';
import type { HandLandmarksPayload } from '../modules/hand-tracker';

export type TrackingQualityStatus = 'good' | 'poor' | 'none';

const WINDOW_SIZE = 30; // ~1s at 30fps
const DEBOUNCE_FRAMES = 15; // consecutive frames before status changes
const MIN_DETECTION_RATE_NONE = 0.2;
const MIN_DETECTION_RATE_POOR = 0.7;
const MIN_AVG_CONFIDENCE_POOR = 0.5;

function computeRawStatus(
  detectionRate: number,
  avgConfidence: number,
): TrackingQualityStatus {
  if (detectionRate < MIN_DETECTION_RATE_NONE) return 'none';
  if (avgConfidence < MIN_AVG_CONFIDENCE_POOR || detectionRate < MIN_DETECTION_RATE_POOR) {
    return 'poor';
  }
  return 'good';
}

export function useTrackingQuality(): {
  status: TrackingQualityStatus;
  reportFrame: (payload: HandLandmarksPayload) => void;
} {
  const [status, setStatus] = useState<TrackingQualityStatus>('none');

  // Rolling window bookkeeping — plain refs, no Reanimated shared values.
  const windowRef = useRef<{ detected: boolean; avgConfidence: number }[]>([]);
  const pendingStatusRef = useRef<TrackingQualityStatus>('none');
  const pendingCountRef = useRef(0);

  const reportFrame = useCallback((payload: HandLandmarksPayload) => {
    const { detected, landmarks } = payload;
    // Frames with no detected hand carry no confidence sample — detection
    // rate alone covers the "no hand" case, so we don't count them as 0.
    const frameAvgConfidence =
      detected && landmarks.length > 0
        ? landmarks.reduce((sum, l) => sum + l.confidence, 0) / landmarks.length
        : 0;

    const win = windowRef.current;
    win.push({ detected, avgConfidence: frameAvgConfidence });
    if (win.length > WINDOW_SIZE) win.shift();

    const detectedFrames = win.filter((f) => f.detected);
    const detectionRate = detectedFrames.length / win.length;
    const avgConfidence =
      detectedFrames.length > 0
        ? detectedFrames.reduce((sum, f) => sum + f.avgConfidence, 0) / detectedFrames.length
        : 0;

    const rawStatus = computeRawStatus(detectionRate, avgConfidence);

    // Debounce: only commit a status change after DEBOUNCE_FRAMES consecutive
    // frames agree on a status different from what's currently exposed.
    if (rawStatus === pendingStatusRef.current) {
      pendingCountRef.current += 1;
    } else {
      pendingStatusRef.current = rawStatus;
      pendingCountRef.current = 1;
    }

    if (pendingCountRef.current >= DEBOUNCE_FRAMES && rawStatus !== status) {
      setStatus(rawStatus);
    }
  }, [status]);

  return { status, reportFrame };
}
