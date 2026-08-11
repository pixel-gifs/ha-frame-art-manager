import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// base './' keeps every asset URL relative to index.html, so the built app
// works at /collage/ whether reached directly (LAN port) or through the HA
// ingress prefix (/api/hassio_ingress/<token>/collage/).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:8099',
      '/thumbs': 'http://localhost:8099',
      '/library': 'http://localhost:8099',
    },
  },
});
