import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
/** @type {import('tailwindcss').Config} */
export default {
  content: [path.join(here, "index.html"), path.join(here, "src/**/*.{ts,tsx}")],
  theme: {
    extend: {
      colors: {
        bg: "#0b0b0f", panel: "#13131a", raised: "#1b1b24", line: "#262633", ink: "#ededf2", mute: "#8d8d9c", faint: "#5d5d6b",
        accent: "#c6ff3d", accentink: "#0b0b0f", ai: "#8b7bff", hot: "#ff4d6d", warn: "#ffb020", ok: "#3ddc97",
      },
      fontFamily: { sans: ["Inter", "system-ui", "sans-serif"], mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"] },
      borderRadius: { xl: "14px", "2xl": "18px" },
    },
  },
  plugins: [],
};
