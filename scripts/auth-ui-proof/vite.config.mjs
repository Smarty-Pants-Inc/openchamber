import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const at = relative => fileURLToPath(new URL(relative, import.meta.url));
export default defineConfig({
  root: at('./'),
  plugins: [react()],
  resolve: { alias: { '@': at('../../packages/ui/src') } },
  css: { postcss: at('../../') },
  build: { outDir: at('../../.auth-ui-build'), emptyOutDir: true },
  preview: { host: '127.0.0.1', port: 4179, strictPort: true },
});
