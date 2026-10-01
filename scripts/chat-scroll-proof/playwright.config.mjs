import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const output = process.env.SCROLL_PROOF_OUT ?? `${process.env.TMPDIR ?? '/tmp'}/chat-scroll-results`;
export default defineConfig({
  testDir: '.', testMatch: 'scroll.browser.mjs', workers: 1, retries: 0, timeout: 45000,
  outputDir: output, reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4187', browserName: 'chromium', channel: 'chromium',
    launchOptions: { args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] },
    serviceWorkers: 'block', video: 'on', screenshot: 'only-on-failure' },
  projects: [ { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } } ],
  webServer: { cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command: 'node node_modules/vite/bin/vite.js build --config scripts/chat-scroll-proof/vite.config.mjs && node node_modules/vite/bin/vite.js preview --config scripts/chat-scroll-proof/vite.config.mjs',
    url: 'http://127.0.0.1:4187', reuseExistingServer: false, timeout: 180000 },
});
