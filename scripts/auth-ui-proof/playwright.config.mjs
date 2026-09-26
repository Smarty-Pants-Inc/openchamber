import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  testDir: '.', testMatch: ['proof.browser.mjs', 'preview-sandbox.browser.mjs', 'loopback-origin.browser.mjs'], workers: 1, retries: 0,
  timeout: 30000, forbidOnly: true,
  outputDir: '../../.auth-ui-proof/results',
  reporter: [['list'], ['html', {
    outputFolder: fileURLToPath(new URL('../../.auth-ui-proof/report', import.meta.url)), open: 'never',
  }]],
  use: { baseURL: 'http://127.0.0.1:4179', browserName: 'chromium', channel: 'chromium',
    locale: 'en-US',
    serviceWorkers: 'block', trace: 'on', screenshot: 'on', video: 'off' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1100, height: 850 } } },
    { name: 'mobile-layout', use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: { cwd: fileURLToPath(new URL('../../', import.meta.url)),
    command: 'node node_modules/vite/bin/vite.js preview --config scripts/auth-ui-proof/vite.config.mjs',
    url: 'http://127.0.0.1:4179', reuseExistingServer: false, timeout: 20000 },
});
