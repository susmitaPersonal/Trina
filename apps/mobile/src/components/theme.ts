import { useColorScheme } from 'react-native';

/** Outdoor-legible palette: high contrast, readable in sunlight. Tokens only; never hard-code colours in screens. */
const light = {
  bg: '#F6F8F4',
  surface: '#FFFFFF',
  surfaceAlt: '#E9EFE6',
  text: '#0E1A12',
  textMuted: '#4A5A4F',
  border: '#C9D4C5',
  primary: '#1F7A3A',
  primaryText: '#FFFFFF',
  accent: '#E8B100',
  danger: '#B3261E',
  warn: '#8A5A00',
  warnBg: '#FFF3D6',
  ok: '#1F7A3A',
  okBg: '#E2F4E6',
  info: '#1D4F91',
  infoBg: '#E3ECFA',
  offline: '#5B4A00',
  offlineBg: '#FFE8A3',
};

const dark: typeof light = {
  bg: '#0B120D',
  surface: '#132018',
  surfaceAlt: '#1B2B21',
  text: '#F1F7F2',
  textMuted: '#A9BCAE',
  border: '#2D4234',
  primary: '#5CD27E',
  primaryText: '#04140A',
  accent: '#FFCB3D',
  danger: '#FF8A80',
  warn: '#FFCB3D',
  warnBg: '#3A2E0A',
  ok: '#5CD27E',
  okBg: '#173322',
  info: '#8DB8FF',
  infoBg: '#14233B',
  offline: '#FFE08A',
  offlineBg: '#3A300A',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24, xxl: 32 };
export const radius = { s: 8, m: 12, l: 20 };
export const font = { small: 14, body: 17, big: 20, h2: 24, h1: 32, huge: 56 };
/** Minimum touch target (dp) for outdoor use, gloves, wet hands. */
export const TOUCH = 56;
