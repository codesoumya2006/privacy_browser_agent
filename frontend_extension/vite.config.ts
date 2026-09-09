import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// package.json has "type": "module", so __dirname isn't available natively
// in this ESM config file -- derive it from import.meta.url instead.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Manifest V3 needs three independent, non-hashed entry bundles:
// background service worker, the content script, and the side panel React app.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        contentScript: resolve(__dirname, "src/contentScript.ts"),
        sidepanel: resolve(__dirname, "src/sidepanel/index.html"),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "background") return "src/background.js";
          if (chunk.name === "contentScript") return "src/contentScript.js";
          return "assets/[name]-[hash].js";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
