import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/meltem-altintas-prov2/',
  build: {
    outDir: 'dist'
  }
})
