import type { Config } from "tailwindcss";

/**
 * Dark ops-console theme built on the validated reference dataviz palette
 * (dark-surface steps). Red is reserved for actual risk/errors; green for
 * confirmed positive states only. UP/DOWN use categorical blue/orange.
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        page: "#0d0d0d",
        panel: "#1a1a19",
        panel2: "#22221f",
        hairline: "rgba(255,255,255,0.10)",
        grid: "#2c2c2a",
        ink: "#ffffff",
        ink2: "#c3c2b7",
        muted: "#898781",
        up: "#3987e5",     // categorical slot 1 (dark)
        down: "#d95926",   // categorical slot 2 (dark)
        good: "#0ca30c",
        warning: "#fab219",
        serious: "#ec835a",
        critical: "#d03b3b",
        accent: "#3987e5",
      },
      fontFamily: {
        sans: ["system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
