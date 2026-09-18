/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { defineConfig, devices, type Project } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173';
const chromeExecutablePath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE_PATH;
const enableChrome = process.env.PLAYWRIGHT_BRANDED_CHROME === '1';

const projects: Project[] = [
  {
    name: 'chromium',
    use: {
      ...devices['Desktop Chrome'],
      browserName: 'chromium',
    },
  },
];

if (chromeExecutablePath !== undefined || enableChrome) {
  projects.push({
    name: 'chrome',
    use: {
      ...devices['Desktop Chrome'],
      browserName: 'chromium',
      ...(chromeExecutablePath === undefined
        ? { channel: 'chrome' }
        : { launchOptions: { executablePath: chromeExecutablePath } }),
    },
  });
}

export default defineConfig({
  testDir: './test/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter:
    process.env.CI === 'true' ? [['line'], ['html', { open: 'never' }]] : 'line',
  outputDir: 'test-results/playwright',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects,
  webServer: {
    command: 'node test/browser/build.mjs && node test/browser/server.mjs',
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
