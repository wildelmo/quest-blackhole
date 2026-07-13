import { defineConfig } from 'vite';

// Relative base so the same build works on GitHub Pages
// (https://wildelmo.github.io/quest-blackhole/) and any other static host.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    host: true, // expose on LAN for headset testing against a dev tunnel if desired
  },
});
