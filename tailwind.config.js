const token = (name) => `var(--pb-${name})`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // Paper is light-only, including when a saved preference adds .dark.
  // Keep legacy dark: classes inert until the remaining pages are restyled.
  darkMode: ["variant", "&:where(:not(*))"],
  theme: {
    extend: {
      colors: {
        ...Object.fromEntries([
          "bg", "surface", "surface-2", "surface-3", "line", "line-strong",
          "text", "heading", "text-2", "text-3", "accent", "accent-bg",
          "on-accent", "accent-soft", "invert-bg", "invert-text", "invert-muted",
          "invert-line", "warn", "warn-bg", "warn-line", "danger", "danger-bg",
          "danger-line", "ok",
        ].map((name) => [name, token(name)])),
        // Compatibility for pages awaiting their own visual pass.
        ink: {
          50: token("bg"), 100: token("surface-2"), 200: token("line"),
          300: token("line"), 400: token("text-3"), 500: token("text-3"),
          600: token("text-2"), 700: token("text-2"), 800: token("text"),
          900: token("heading"), 950: token("heading"),
        },
        pearl: {
          50: token("accent-soft"), 100: token("surface-2"), 200: token("surface-3"),
          300: token("line"), 400: token("accent"), 500: token("accent"),
          600: token("accent"), 700: token("accent"), 800: token("heading"),
          900: token("heading"),
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        DEFAULT: "2px", sm: "2px", md: "2px", lg: "2px", xl: "2px",
        "2xl": "2px", "3xl": "2px", pb: "2px",
      },
      boxShadow: {
        sm: "none", DEFAULT: "none", md: "none", lg: "none", xl: "none", "2xl": "none",
        slab: "6px 6px 0 var(--pb-heading)", slabsm: "4px 4px 0 var(--pb-heading)",
      },
    },
  },
  plugins: [],
};
