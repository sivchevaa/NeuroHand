import { requireNativeViewManager } from 'expo-modules-core';
import React, { forwardRef, type Ref } from 'react';
import type { ViewProps } from 'react-native';

export type HandLandmark = {
  x: number;
  y: number;
  confidence: number;
};

export type HandLandmarksPayload = {
  detected: boolean;
  landmarks: HandLandmark[];
};

export type HandTrackerViewProps = ViewProps & {
  onHandLandmarks?: (event: { nativeEvent: HandLandmarksPayload }) => void;
};

// Imperative methods exposed on the native view instance, callable via a ref
// (e.g. `viewRef.current?.takeSnapshot()`), matching the pattern expo-camera
// uses for CameraView.takePictureAsync.
export type HandTrackerViewRef = {
  // Captures a single still frame, cropped/mirrored to match the live preview,
  // and returns a file:// URI to a temporary JPEG.
  takeSnapshot: () => Promise<string>;
};

// requireNativeViewManager's prop type must declare `ref` itself for
// React.createElement to accept it — kept internal so the public
// HandTrackerViewProps type (and existing callers) stay unchanged.
type NativeHandTrackerViewProps = HandTrackerViewProps & {
  ref?: Ref<HandTrackerViewRef>;
};

const NativeView =
  requireNativeViewManager<NativeHandTrackerViewProps>('HandTracker');

export const HandTrackerView = forwardRef<HandTrackerViewRef, HandTrackerViewProps>(
  (props, ref) => {
    return React.createElement(NativeView, { ...props, ref });
  },
);
