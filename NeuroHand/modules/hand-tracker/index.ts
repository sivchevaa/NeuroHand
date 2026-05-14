import { requireNativeViewManager } from 'expo-modules-core';
import React from 'react';
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

const NativeView =
  requireNativeViewManager<HandTrackerViewProps>('HandTracker');

export function HandTrackerView(props: HandTrackerViewProps) {
  return React.createElement(NativeView, props);
}
