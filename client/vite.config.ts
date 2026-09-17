import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API lives in ../server (default port 3001).
// /api/* is proxied there so the browser only ever talks to the Vite origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
