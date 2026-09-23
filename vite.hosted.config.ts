import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwind()],
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: [
      { find: /^next\/link$/, replacement: path.resolve(__dirname, "src/hosted/link.tsx") },
      { find: /^next\/navigation$/, replacement: path.resolve(__dirname, "src/hosted/navigation.ts") },
      { find: "@", replacement: path.resolve(__dirname, "src") },
    ],
  },
  build: { outDir: "dist-hosted" },
});
