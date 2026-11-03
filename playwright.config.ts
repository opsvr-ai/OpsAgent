import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        },
      },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @opsagent/control seed:dev && pnpm --filter @opsagent/control dev',
      port: 8080,
      reuseExistingServer: true,
      timeout: 120_000,
      env: {
        LOCAL_ADMIN_ENABLED: 'true',
        LOCAL_ADMIN_USERNAME: 'tenant-admin',
        LOCAL_ADMIN_PASSWORD: 'opsagent-dev',
      },
    },
    {
      command: 'pnpm --filter @opsagent/web exec vite --host 127.0.0.1 --port 5173',
      port: 5173,
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
