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
    },
  },
  plugins: [],
};

export default config;
