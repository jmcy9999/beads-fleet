import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "status-open": "#22c55e",
        "status-progress": "#f59e0b",
        "status-blocked": "#ef4444",
        "status-closed": "#6b7280",
        "status-deferred": "#8b5cf6",
        "status-pinned": "#3b82f6",
        "priority-critical": "#ef4444",
        "priority-high": "#f97316",
        "priority-medium": "#eab308",
        "priority-low": "#22c55e",
        "priority-minimal": "#6b7280",
        "surface-0": "#0f1117",
        "surface-1": "#1a1d27",
        "surface-2": "#252830",
        "surface-3": "#2f323c",
        "border-default": "#353845",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      keyframes: {
        "slide-in": {
          "0%": { opacity: "0", transform: "translateX(1rem)" },
          "100%": { opacity: "1", transform: "translateX(0)" },
        },
      },
      animation: {
        "slide-in": "slide-in 0.2s ease-out",
      },
    },
  },
  plugins: [require("@tailwindcss/typography")],
};

export default config;
