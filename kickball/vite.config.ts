import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { open: true },
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      // Fixed file names so the web page can load the build as assets/game.js
      output: {
        entryFileNames: 'assets/game.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
