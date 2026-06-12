import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    // 生产构建不产出 sourcemap(默认即关,显式声明以防回归)
    sourcemap: false,
  },
  server: {
    // 开发模式:API 代理到本地 cloudllm 进程
    proxy: { '/admin/api': 'http://localhost:7200' },
  },
});
