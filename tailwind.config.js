/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "media",
  theme: {
    extend: {
      colors: {
        // Calm palette — neutral, no excitement.
        ink: {
          50: "#fafaf9",
          100: "#f4f4f3",
          200: "#e7e7e5",
          300: "#d2d2cf",
          400: "#a3a39e",
          500: "#737370",
          600: "#52524f",
          700: "#3a3a38",
          800: "#262624",
          900: "#171716",
          950: "#0c0c0b",
        },
        pearl: {
          50: "#f5f7fa",
          100: "#e8edf4",
          200: "#cbd5e3",
          300: "#9eb1ca",
          400: "#6c87ad",
          500: "#4a6791",
          600: "#395078",
          700: "#2e4062",
          800: "#283651",
          900: "#1f2940",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
    },
  },
  plugins: [],
};
