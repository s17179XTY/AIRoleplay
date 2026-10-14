import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Windows 上 fs.watch 偶尔会对"正被别的进程占用的文件"抛 EBUSY，
 * 而 Vite 没有给 FSWatcher 挂 error 监听，Node 就把整个 dev server 干掉。
 * 这里补一个监听：忽略这类瞬时错误，开发服务器不再猝死。
 */
const watchErrorGuard: Plugin = {
  name: 'dsh-watch-error-guard',
  configureServer(server) {
    server.watcher.on('error', (err: unknown) => {
      console.warn('[watch] 已忽略文件监视错误:', err instanceof Error ? err.message : String(err));
    });
  },
};

export default defineConfig({
  plugins: [watchErrorGuard, react(), tailwindcss()],
  server: {
    host: true, // 允许手机通过局域网 IP 访问，便于真机调试
    watch: {
      // 忽略编辑器原子写入的临时目录、密钥文件、构建产物，少踩 EBUSY
      ignored: [
        '**/.*.tmpdir/**',
        '**/*.tmp',
        '**/shots/**',
        '**/.env',
        '**/.env.*',
        '**/.dev.vars',
        '**/.wrangler/**',
        '**/dist/**',
        '**/*.log',
      ],
    },
  },
  test: {
    environment: 'jsdom',
    css: true, // 让测试能读到编译后的 CSS，用于布局约束的回归检查
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'worker/**/*.test.ts'],
  },
});
