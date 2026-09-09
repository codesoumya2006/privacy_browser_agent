/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,tsx,ts}"],
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: "#38bdf8",
          dim: "#0ea5e9",
        },
      },
      backdropBlur: {
        xl: "24px",
      },
      boxShadow: {
        glow: "0 0 20px #38bdf8",
      },
      keyframes: {
        pulseRing: {
          "0%": { boxShadow: "0 0 0 0 rgba(56, 189, 248, 0.6)" },
          "70%": { boxShadow: "0 0 0 12px rgba(56, 189, 248, 0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(56, 189, 248, 0)" },
        },
      },
      animation: {
        "pulse-ring": "pulseRing 1.6s cubic-bezier(0.4, 0, 0.6, 1) infinite",
      },
    },
  },
  plugins: [],
};
