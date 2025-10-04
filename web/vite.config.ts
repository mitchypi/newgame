import { defineConfig } from 'vite';

export default defineConfig({
  // Use relative asset paths so the app can be hosted
  // at any subpath or as a static bundle.
  base: './',
  server: {
    port: 5173,
  },
});
