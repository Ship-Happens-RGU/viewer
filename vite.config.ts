// SPDX-License-Identifier: GPL-3.0-only
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss()],
  server: { port: 5180, host: '127.0.0.1', strictPort: false },
  worker: { format: 'es' },
  assetsInclude: ['**/*.wasm'],
  build: { outDir: 'dist', emptyOutDir: true },
});
