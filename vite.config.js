import { defineConfig } from 'vite';

// Vite configuration for Web Studio.
// - The app sources live in `src/` (index.html is the entry).
// - Static assets live in `public/` and are copied to the output root.
// - The production output goes to `dist/`, which is exactly the directory
//   referenced by the `assets.directory` field in wrangler.jsonc.
export default defineConfig({
  root: 'src',
  publicDir: '../public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1200
  },
  server: {
    port: 5173,
    open: false
  },
  preview: {
    port: 4173,
    open: false
  }
});
