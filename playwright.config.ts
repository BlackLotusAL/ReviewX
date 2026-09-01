import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:3210",
    trace: "retain-on-failure",
  },
  reporter: [["list"]],
  webServer: {
    command: "node ./node_modules/tsx/dist/cli.mjs tests/e2e/server.ts",
    url: "http://127.0.0.1:3210",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
