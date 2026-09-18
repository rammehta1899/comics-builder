import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Base path matches the GitHub repo name so the app works on GitHub Pages.
// If you rename the repo, update this too.
export default defineConfig({
  base: "/comics-builder/",
  plugins: [react()],
});
