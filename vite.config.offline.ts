// Vite config for the offline single-file HTML build.
//
// Produces `dist-offline/` with a single JS chunk + a single CSS chunk
// + an inlined worker (no separate /assets/worker-*.js fetched at
// runtime). A post-build step (scripts/build-offline.mjs) then folds
// all of that, plus iframe-bust.js and the favicons, into a single
// pearlwallet-offline-vX.Y.Z.html file the user can save and run from
// file:// — fully self-contained, no remote fetches required for the
// app shell.
//
// The web build (vite.config.ts) is unchanged. Online users still get
// the chunked, hashed, long-cached deploy.

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
    // Build-time flag the bundle can branch on. The offline build flips
    // `import CryptoWorker from "./worker?worker"` over to
    // `./worker?worker&inline` via the alias below — the constant is
    // here so future code can ask "am I in the air-gapped bundle?"
    // without sniffing the URL.
    __PEARL_OFFLINE_BUILD__: "true",
  },
  resolve: {
    alias: [
      // Force every worker import to use Vite's inline form. Vite emits
      // the worker bundle as a Blob URL baked into the main chunk —
      // there's no separate /assets/worker-*.js to fetch.
      { find: /^\.\/worker\?worker$/, replacement: "./worker?worker&inline" },
    ],
  },
  build: {
    outDir: "dist-offline",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    // Bundle into a single JS chunk and a single CSS file — easier to
    // inline downstream.
    cssCodeSplit: false,
    // Inline anything small as a data URI. Default is 4 kB; bump high
    // enough to fold the favicons + worker into the main bundle.
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: {
        assetFileNames: "assets/[name][extname]",
        chunkFileNames: "assets/[name].js",
        entryFileNames: "assets/[name].js",
        // Force everything into one chunk — dynamic imports get folded
        // back into the entry, so the post-build inliner only has to
        // deal with one JS file.
        inlineDynamicImports: true,
      },
    },
  },
  worker: {
    format: "es",
  },
});
