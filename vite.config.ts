import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

function gitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  plugins: [react(), {
    name: "wallet-subresource-integrity",
    enforce: "post",
    writeBundle(options) {
      const dir = options.dir ?? "dist";
      const index = join(dir, "index.html");
      // Hash written bytes: Vite's later bundle hooks rewrite import paths
      // after generateBundle, so hashing that intermediate code is unsafe.
      const html = readFileSync(index, "utf8").replace(/<(script|link)\b[^>]*>/g, tag => {
        if (!tag.startsWith("<script") && !/rel="(?:stylesheet|modulepreload)"/.test(tag)) return tag;
        const match = tag.match(/(?:src|href)="\/([^"?#]+)"/);
        if (!match) throw new Error("Expected same-origin script/style");
        const digest = createHash("sha384").update(readFileSync(join(dir, match[1]!))).digest("base64");
        return tag.replace(/>$/, ` integrity="sha384-${digest}">`);
      });
      writeFileSync(index, html);
    },
  }],
  define: {
    __BUILD_GIT_SHA__: JSON.stringify(gitSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: "es2022",
    // No sourcemaps in production: shipping them publishes the full
    // unminified worker source (including HD-derivation + keystore
    // glue) to wallet.pearlbridge.xyz/assets/*.js.map. Flagged in v0.1.7 audit
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
