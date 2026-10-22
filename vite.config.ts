import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'reviewx/web', emptyOutDir: true,
    rollupOptions: { input: {
      app: fileURLToPath(new URL('./index.html', import.meta.url)),
      preview: fileURLToPath(new URL('./preview.html', import.meta.url)),
    } },
  },
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:17080' } },
})
