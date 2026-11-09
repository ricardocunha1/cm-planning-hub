/** Theme-aware color backed by an RGB-channel CSS variable, so opacity modifiers (`bg-surface-raised/60`) work. */
const ui = (name) => `rgb(var(--ui-${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // CM brand palette, backed by the CSS custom properties in src/index.css.
        cm: {
          "dark-blue": "var(--cm-dark-blue)",
          "light-blue": "var(--cm-light-blue)",
          teal: "var(--cm-teal)",
          gold: "var(--cm-gold)",
          orange: "var(--cm-orange)",
          red: "var(--cm-red)",
          purple: "var(--cm-purple)",
        },
        // Semantic neutrals that switch with the theme (values in src/index.css).
        canvas: ui("canvas"),
        surface: {
          DEFAULT: ui("surface"),
          raised: ui("surface-raised"),
          overlay: ui("surface-overlay"),
          strong: ui("surface-strong"),
        },
        line: {
          DEFAULT: ui("line"),
          strong: ui("line-strong"),
          bold: ui("line-bold"),
        },
        fg: {
          DEFAULT: ui("fg"),
          soft: ui("fg-soft"),
          muted: ui("fg-muted"),
          subtle: ui("fg-subtle"),
          faint: ui("fg-faint"),
          dim: ui("fg-dim"),
        },
        // Brand hues as text on neutral surfaces (darkened in light mode for contrast).
        accent: {
          blue: ui("accent-blue"),
          teal: ui("accent-teal"),
        },
        // Inline error text on neutral surfaces.
        danger: ui("danger"),
      },
    },
  },
  plugins: [],
};
