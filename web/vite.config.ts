import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 后端的 CSP 只允许同源脚本、样式与图片，因此构建时不内联任何资源（data: URI 会被拦截）。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    target: ['es2022', 'safari16', 'chrome111', 'firefox115'],
    sourcemap: false,
  },
});
