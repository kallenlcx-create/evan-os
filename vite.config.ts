import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: './',
  build: {
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
  },
  // Electron 开发模式：允许 iframe 和 file:// 协议
  server: {
    headers: {
      'Access-Control-Allow-Origin': '*',
    },
  },
})