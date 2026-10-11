import * as SecureStore from 'expo-secure-store';
import type { DeviceKeyPair } from '@trina/contracts';
import type { TokenStore } from '../core/api-client';
import type { KeyStore } from '../core/confirmations';

const ACCESS = 'trina.accessToken';
const REFRESH = 'trina.refreshToken';
const WEIGHT = 'trina.weightKg';

/** Tokens live only in the Keychain / Android Keystore, never in SQLite or AsyncStorage. */
export const secureTokens: TokenStore = {
  async get() {
    const [accessToken, refreshToken] = await Promise.all([SecureStore.getItemAsync(ACCESS), SecureStore.getItemAsync(REFRESH)]);
    return { accessToken, refreshToken };
  },
  async set(t) {
    if (!t) {
      await Promise.all([SecureStore.deleteItemAsync(ACCESS), SecureStore.deleteItemAsync(REFRESH)]);
      return;
    }
    await Promise.all([SecureStore.setItemAsync(ACCESS, t.accessToken), SecureStore.setItemAsync(REFRESH, t.refreshToken)]);
  },
};

/** Weight is device-only (used for calorie estimates). It never leaves the phone. */
export async function getWeightKg(): Promise<number | null> {
  const v = await SecureStore.getItemAsync(WEIGHT);
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export async function setWeightKg(kg: number | null) {
  if (kg === null) await SecureStore.deleteItemAsync(WEIGHT);
  else await SecureStore.setItemAsync(WEIGHT, String(Math.round(kg)));
}

const DEVICE_KEY = 'trina.deviceKey';

/** The device's Ed25519 key for signed confirmations (ADR-026). Keychain / Keystore only. */
export const secureDeviceKeys: KeyStore = {
  async get() {
    const v = await SecureStore.getItemAsync(DEVICE_KEY);
    try {
      return v ? (JSON.parse(v) as DeviceKeyPair) : null;
    } catch {
      return null;
    }
  },
  async set(k) {
    await SecureStore.setItemAsync(DEVICE_KEY, JSON.stringify(k));
  },
};
