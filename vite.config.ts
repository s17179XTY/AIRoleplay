import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // 允许手机通过局域网 IP 访问，便于真机调试
    watch: {
      // 忽略编辑器原子写入的临时目录，避免文件监视器 EBUSY 崩溃
      ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/shots/**'],
    },
  },
  test: {
    environment: 'jsdom',
    css: true, // 让测试能读到编译后的 CSS，用于布局约束的回归检查
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});