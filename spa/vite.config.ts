import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "./", // relative assets so the bundle works at any path (GitHub Pages subpath, relay-served /board)
  server: { port: 8401 },
  preview: { port: 8401 },
});
