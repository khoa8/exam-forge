import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import path from "node:path";
import { hostedConfigFromEnv, invalidHostedConfigNames } from "./src/lib/hosted-config";

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    const invalid = invalidHostedConfigNames(hostedConfigFromEnv(loadEnv(mode, __dirname)));
    if (invalid.length) {
      throw new Error(`Invalid hosted build configuration: ${invalid.join(", ")}. Supply usable public values before building.`);
    }
  }

  return {
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
  };
});
