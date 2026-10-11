/* Global mocks for rendering real screens in Jest (no device). */
import React from 'react';

export const mockNav = {
  navigate: jest.fn(),
  replace: jest.fn(),
  goBack: jest.fn(),
  reset: jest.fn(),
  canGoBack: jest.fn(() => true),
};
(globalThis as any).mockNav = mockNav;

jest.mock('@react-navigation/native', () => {
  const actual = jest.requireActual('@react-navigation/native');
  return {
    ...actual,
    useNavigation: () => (globalThis as any).mockNav,
    useFocusEffect: (cb: () => void | (() => void)) => {
      const R = jest.requireActual('react') as typeof React;
      R.useEffect(() => cb(), [cb]);
    },
  };
});

jest.mock('react-native-safe-area-context', () => {
  const R = jest.requireActual('react') as typeof React;
  const inset = { top: 0, right: 0, bottom: 0, left: 0 };
  return {
    SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
    SafeAreaView: ({ children }: { children: React.ReactNode }) => R.createElement('View', null, children),
    useSafeAreaInsets: () => inset,
  };
});

jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(async () => undefined),
  impactAsync: jest.fn(async () => undefined),
  NotificationFeedbackType: { Success: 'success' },
  ImpactFeedbackStyle: { Heavy: 'heavy' },
}));

jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  getPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true, status: 'granted' })),
  setNotificationHandler: jest.fn(),
}));

jest.mock('@react-native-community/netinfo', () => ({ addEventListener: jest.fn(() => () => undefined), fetch: jest.fn(async () => ({ isConnected: true })) }));

// Native-only modules the screens import transitively.
jest.mock('../src/platform/expo-db', () => ({ openDeviceDb: jest.fn() }));
jest.mock('../src/platform/files', () => ({
  storeEvidencePhoto: jest.fn(async () => ({ uri: 'file:///photo.jpg', sha256: 'a'.repeat(64), bytes: 1234 })),
  freeBytes: jest.fn(async () => 5_000_000_000),
  expoUploader: jest.fn(),
  deleteFile: jest.fn(),
}));
jest.mock('../src/platform/session-runtime', () => ({
  startRuntime: jest.fn(async () => 'background'),
  stopRuntime: jest.fn(async () => undefined),
  adaptSampling: jest.fn(async () => undefined),
  distanceToNext: jest.fn(() => null),
  trackingMode: jest.fn(() => 'background'),
  resumeRuntimeIfNeeded: jest.fn(async () => null),
}));
jest.mock('../src/platform/secure', () => ({ getWeightKg: jest.fn(async () => null), setWeightKg: jest.fn(), secureTokens: {} }));
jest.mock('../src/platform/llama', () => ({ llamaAvailable: () => false, deviceRamGb: () => 8, LlamaRnProvider: class {} }));
