/**
 * Light, dark, or whatever the workstation is set to.
 *
 * The default stays "system": these are shared clinical machines configured centrally, and a
 * per-app override that ignored the site's own setting would be the wrong default. But it is a
 * default, not a rule — a reader on a bright ward at midday can say otherwise, and the choice is
 * remembered on that machine.
 *
 * The choice is applied as a `data-theme` attribute on the document element; index.css holds the
 * values for both directions, so nothing here knows a single colour.
 */

export type Theme = 'system' | 'light' | 'dark';

const KEY = 'opd.theme';

export const THEMES: Theme[] = ['system', 'light', 'dark'];

export const THEME_LABEL: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

export function readTheme(): Theme {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // A browser with site data blocked still gets a working app, on the system setting.
  }
  return 'system';
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', theme);
  }
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Not remembering the choice is survivable; failing to apply it is not.
  }
}

/**
 * Apply the stored choice before React mounts, so the first paint is already the right colour
 * rather than a white flash that resolves a frame later.
 */
export function initTheme(): void {
  const theme = readTheme();
  if (theme !== 'system') document.documentElement.setAttribute('data-theme', theme);
}
