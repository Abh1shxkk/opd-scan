/** @type {import('tailwindcss').Config} */

/**
 * The Case Sheet.
 *
 * The palette is deliberately small and every colour in it is *functional*. Paper, rule and the
 * two ink greys build every surface; `chart` is the only structural accent; and `band`, `note` and
 * `plot` are reserved exclusively for status meaning. Nothing decorative is ever coloured — the
 * same rule a printed observation chart follows, where red ink means a reading is out of range and
 * nothing else.
 *
 * Colours resolve through CSS custom properties (see index.css) rather than being written twice
 * per element. One consequence matters: there are no `dark:` variants anywhere in this app. The
 * variables flip under `prefers-color-scheme` and every utility follows automatically.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  // 'media' is the default: clinical workstations are configured centrally, so the OS setting is
  // the right starting point. It is not a lock — index.css also honours a `data-theme` attribute
  // written by the Appearance control, which wins in both directions.
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        /** Chart stock. `paper-2` is the ruled band, `paper-3` the printed header fill. */
        paper: 'rgb(var(--c-paper) / <alpha-value>)',
        'paper-2': 'rgb(var(--c-paper-2) / <alpha-value>)',
        'paper-3': 'rgb(var(--c-paper-3) / <alpha-value>)',
        /** Printed rules. `rule` is the hairline grid, `rule-2` the section and table rule. */
        rule: 'rgb(var(--c-rule) / <alpha-value>)',
        'rule-2': 'rgb(var(--c-rule-2) / <alpha-value>)',
        /** Writing ink and the pencil grey used for secondary text and unmeasured values. */
        ink: 'rgb(var(--c-ink) / <alpha-value>)',
        'ink-2': 'rgb(var(--c-ink-2) / <alpha-value>)',
        /** The one structural accent: pre-printed chart blue. Links, primary actions, plot axes. */
        chart: 'rgb(var(--c-chart) / <alpha-value>)',
        /** Status inks. Never used for decoration, chrome, or emphasis. */
        band: 'rgb(var(--c-band) / <alpha-value>)',
        note: 'rgb(var(--c-note) / <alpha-value>)',
        plot: 'rgb(var(--c-plot) / <alpha-value>)',
      },
      fontFamily: {
        sans: ['Archivo', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        /** Condensed caps, the way a pre-printed form sets its field labels. */
        label: ['"Archivo Narrow"', 'Archivo', 'system-ui', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      // A printed chart has cut corners, not rounded ones, so the whole scale collapses to 2px and
      // every legacy `rounded-xl`/`rounded-lg` resolves there too. `full` is kept defined so a
      // stray utility cannot fall back to Tailwind's default, but nothing in this build uses it —
      // the verdict stamps are rectangles.
      borderRadius: {
        none: '0',
        sm: '1px',
        DEFAULT: '2px',
        md: '2px',
        lg: '2px',
        xl: '2px',
        '2xl': '2px',
        '3xl': '2px',
        full: '9999px',
      },
      // Elevation is declared once, as a rule. Ink on paper does not float, so every shadow
      // utility resolves to nothing and cannot creep back in through a stray class.
      boxShadow: {
        none: 'none',
        sm: 'none',
        DEFAULT: 'none',
        md: 'none',
        lg: 'none',
        xl: 'none',
        '2xl': 'none',
        inner: 'none',
      },
      letterSpacing: {
        label: '0.08em',
        tight: '-0.02em',
      },
      transitionTimingFunction: {
        // Damped, no overshoot — the motion grammar this world allows.
        chart: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
      },
    },
  },
  plugins: [],
};
