/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // 'media': the app follows the operating system's prefers-color-scheme. Clinical workstations
  // are configured centrally, so an in-app override would fight the site's own setting.
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        // Status colours are always paired with a text label in the UI (see StatusPill); they are
        // never the sole carrier of meaning. Shades chosen for >=4.5:1 against their pill background.
        ok: { fg: '#14532d', bg: '#dcfce7', dfg: '#bbf7d0', dbg: '#14532d' },
        warn: { fg: '#78350f', bg: '#fef3c7', dfg: '#fde68a', dbg: '#78350f' },
        bad: { fg: '#7f1d1d', bg: '#fee2e2', dfg: '#fecaca', dbg: '#7f1d1d' },
        info: { fg: '#1e3a8a', bg: '#dbeafe', dfg: '#bfdbfe', dbg: '#1e3a8a' },
        neutral2: { fg: '#334155', bg: '#e2e8f0', dfg: '#cbd5e1', dbg: '#334155' },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
