import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/ui',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:17081', channel: process.platform === 'win32' ? 'msedge' : undefined, viewport: { width: 1440, height: 1000 }, headless: true, screenshot: 'only-on-failure' },
  webServer: { command: 'python tests/e2e_server.py', url: 'http://127.0.0.1:17081/api/health', timeout: 20_000, reuseExistingServer: false },
})
