import { defineConfig } from 'vite';

// En développement, Vite sert le mur (port 5176) et passe la connexion /ws et les images au pont (port 5050).
export default defineConfig({
  server: { port: 5176, strictPort: true, proxy: { '/ws': { target: 'ws://127.0.0.1:5050', ws: true }, '/run': { target: 'http://127.0.0.1:5050' } } },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
