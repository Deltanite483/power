import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the build also runs from a subpath (GitHub Pages serves it at /power/).
  base: "./",
  worker: { format: "es" },
  server: { port: 5190 },
});
