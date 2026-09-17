/**
 * Colours and spacing for the app. The palette follows the web app — chart blue as the one accent,
 * warm paper background, and status inks used only for statuses.
 */

import { useColorScheme } from 'react-native';

export const Colors = {
  light: {
    background: '#F4F3EE',
    surface: '#FBFAF6',
    surfaceAlt: '#EFEDE5',
    border: '#DEDAD0',
    text: '#1B1F24',
    textSecondary: '#5E646B',
    primary: '#1F4E79',
    primaryText: '#FFFFFF',
    ok: '#2E7D4F',
    okBg: '#E4F1E8',
    warn: '#A86A12',
    warnBg: '#F7ECD9',
    bad: '#B3372E',
    badBg: '#F6E1DE',
    neutralBg: '#E7E5DE',
  },
  dark: {
    background: '#111417',
    surface: '#181C20',
    surfaceAlt: '#20252A',
    border: '#2E343A',
    text: '#E8EAEC',
    textSecondary: '#9AA2A9',
    primary: '#7FB3E0',
    primaryText: '#0E1A24',
    ok: '#6CC08F',
    okBg: '#1C2E23',
    warn: '#E0A94E',
    warnBg: '#33281A',
    bad: '#E57F75',
    badBg: '#3A1F1C',
    neutralBg: '#262B30',
  },
} as const;

export type Palette = { [K in keyof typeof Colors.light]: string };

export function useColors(): Palette {
  return useColorScheme() === 'dark' ? Colors.dark : Colors.light;
}

export const Space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const Radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;
