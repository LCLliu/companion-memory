import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // 只代理 /api/ 前缀；写成 /api 会把前端模块 /api.ts 也代理走。
      '^/api/': 'http://127.0.0.1:3210',
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
})
