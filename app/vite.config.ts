import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const rootDir = import.meta.dirname;

// Keep in sync with DEFAULT_RESEARCH_CONSOLE_PORT in src/config.ts; app/dev.ts
// Passes the resolved port via MARKET_BOT_CONSOLE_PORT so this fallback only
// Applies when running vite directly.
const DEFAULT_CONSOLE_PORT = 4173;
const consolePort = Number(process.env.MARKET_BOT_CONSOLE_PORT) || DEFAULT_CONSOLE_PORT;

export default defineConfig({
  root: "app",
  plugins: [tailwindcss(), svelte()],
  resolve: {
    alias: {
      $lib: resolve(rootDir, "client/lib"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${consolePort}`,
    },
  },
});
