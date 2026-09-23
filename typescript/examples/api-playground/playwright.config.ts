/*
 * Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
 */

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  expect: {
    toHaveScreenshot: {
      // Bound platform antialiasing noise while still failing meaningful visual drift.
      maxDiffPixelRatio: 0.001,
    },
  },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173/api/config',
    env: {
      SAM_API_KEY: '',
      SAM_MODEL: '',
    },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
