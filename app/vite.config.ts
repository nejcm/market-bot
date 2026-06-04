import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const rootDir = import.meta.dirname;

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
});
