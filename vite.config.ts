import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri expects a fixed port and ignores VITE_ env files it doesn't control.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // Cargo artifacts are locked mid-build, and watching them crashes Vite on Windows.
    watch: { ignored: ["**/target/**", "**/src-tauri/**"] },
  },
});
