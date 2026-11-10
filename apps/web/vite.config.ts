import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Windows bind mount 下 inotify 事件不可靠，容器内开发用轮询保证热更新。
    watch: { usePolling: true, interval: 300 },
    proxy: {
      '/api': process.env.VITE_API_PROXY ?? 'http://localhost:8080',
    },
  },
});
