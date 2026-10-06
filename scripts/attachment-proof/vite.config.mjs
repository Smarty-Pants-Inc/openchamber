import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const at = relative => fileURLToPath(new URL(relative, import.meta.url));
const ui = process.env.ATTACHMENT_BASELINE ? `${process.env.ATTACHMENT_BASELINE}/packages/ui/src` : at('../../packages/ui/src');
export default defineConfig({
  root: at('./'), plugins: [react()],
  resolve: { alias: { '@opencode-ai/sdk/v2': at('../../node_modules/@opencode-ai/sdk/dist/v2/client.js'), '@': ui, '@openchamber/ui': ui } },
  css: { postcss: at('../../') }, worker: { format: 'es' },
  define: { 'process.env': {} },
  server: { host: '127.0.0.1', port: 4180, strictPort: true, fs: { allow: [at('../../'), ui] } },
});
