import AsyncStorage from '@react-native-async-storage/async-storage';

export type CalibrationData = {
  palmLengthMm: number;
  widthToLengthRatio: number;
  handedness: 'left' | 'right';
  capturedAt: string; // ISO timestamp
  version: 1;
};

const STORAGE_KEY = 'neurohand:calibration';

function isValidCalibration(value: unknown): value is CalibrationData {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.palmLengthMm === 'number' &&
    Number.isFinite(v.palmLengthMm) &&
    v.palmLengthMm >= 50 &&
    v.palmLengthMm <= 130 &&
    typeof v.widthToLengthRatio === 'number' &&
    Number.isFinite(v.widthToLengthRatio) &&
    (v.handedness === 'left' || v.handedness === 'right') &&
    typeof v.capturedAt === 'string' &&
    v.version === 1
  );
}

export async function saveCalibration(data: CalibrationData): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

export async function getCalibration(): Promise<CalibrationData | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return isValidCalibration(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function isCalibrated(): Promise<boolean> {
  return (await getCalibration()) !== null;
}

export async function clearCalibration(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
