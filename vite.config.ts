import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    // Vite's default 500 kB warning goes to stderr, and `build.ps1` runs under
    // `$ErrorActionPreference = "Stop"`, which promotes any native stderr line
    // to a fatal error — aborting the build before the Rust step. Raise the
    // limit so a clean build stays quiet on stderr.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Pin the two heavy dependency trees into chunks of their own so they
        // can only ever be reached through the lazy boundaries that need them
        // (`SkillMarkdown`, the Admin page), never folded into the entry chunk.
        manualChunks: {
          markdown: ["react-markdown", "remark-gfm", "rehype-highlight"],
          diff: ["react-diff-viewer-continued"],
        },
      },
    },
  },
});
