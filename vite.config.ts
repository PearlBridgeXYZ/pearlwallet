import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_GIT_SHA__: JSON.stringify(gitSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: "es2022",
    // No sourcemaps in production: shipping them publishes the full
    // unminified worker source (including HD-derivation + keystore
    // glue) to pearlwallet.xyz/assets/*.js.map. Flagged in v0.1.7 audit
    // by three of four auditors. Set to "hidden" if a future build
    // pipeline uploads to Sentry — but it MUST NOT land in /assets.
    sourcemap: false,
    rollupOptions: {
      output: {
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
        entryFileNames: "assets/[name]-[hash].js",
      },
    },
  },
  worker: {
    format: "es",
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
});
