import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// The Tauri CLI sets this when it drives Vite.
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Vite options tailored for Tauri development.
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // Cargo workspaces share one `target/` at the workspace root (this
      // project has crates/ alongside src-tauri/), not per-member, so it has
      // to be ignored separately from src-tauri itself - otherwise Vite
      // tries to watch build artifacts while cargo is actively writing them.
      ignored: ["**/src-tauri/**", "**/target/**", "**/crates/**/target/**"],
    },
  },

  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: false,
  },
}));
