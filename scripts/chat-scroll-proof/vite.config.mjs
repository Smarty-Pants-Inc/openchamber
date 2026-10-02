import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
const at = relative => fileURLToPath(new URL(relative, import.meta.url));
// Use the production ChatContainer's presentation props, including native anchoring policy.
const source = readFileSync(at('../../packages/ui/src/components/chat/ChatContainer.tsx'), 'utf8');
const style = source.match(/const CHAT_SCROLL_STYLE = ([\s\S]*?) as const;/)?.[1];
if (!style) throw new Error('ChatContainer scroll style missing');
export default defineConfig({
  root: at('./'), publicDir: at('../../packages/ui/public'), worker: { format: 'es' }, plugins: [react()], resolve: { alias: { '@opencode-ai/sdk/v2': at('../../node_modules/@opencode-ai/sdk/dist/v2/client.js'), '@openchamber/ui': at('../../packages/ui/src'), '@': at('../../packages/ui/src') } },
  define: { __CHAT_SCROLL_STYLE__: JSON.stringify(Object.fromEntries([...style.matchAll(/(\w+): '([^']+)'/g)].map(([, key, value]) => [key, value]))) }, css: { postcss: at('../../') },
  build: { outDir: process.env.TMPDIR ? `${process.env.TMPDIR}/chat-scroll-build` : at('../../.chat-scroll-build'), emptyOutDir: true },
  preview: { host: '127.0.0.1', port: 4187, strictPort: true },
});
