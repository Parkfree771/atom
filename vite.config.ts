import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
    target: 'es2020',
    rollupOptions: {
      output: {
        // Split heavy vendor code so the initial bundle is smaller and pixi can be cached separately.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('pixi.js') || id.includes('@pixi')) return 'pixi';
            if (id.includes('react')) return 'react';
          }
        },
      },
    },
  },
})
