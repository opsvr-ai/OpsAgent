import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:15173',
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
      command:
        'pnpm --filter @opsagent/control exec node scripts/ensure-test-db.mjs && pnpm --filter @opsagent/control seed:dev && pnpm --filter @opsagent/control dev',
      port: 18080,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        DATABASE_URL: 'postgres://opsagent:opsagent@localhost:5432/opsagent_e2e',
        TEST_DATABASE_URL: 'postgres://opsagent:opsagent@localhost:5432/opsagent_e2e',
        LOCAL_ADMIN_ENABLED: 'true',
        LOCAL_ADMIN_USERNAME: 'tenant-admin',
        LOCAL_ADMIN_PASSWORD: 'opsagent-dev',
        DSH_RUNTIME_ENABLED: 'false',
        STUDIO_DSH_ENABLED: 'false',
        OPSAGENT_AGENT_ENROLLMENT_TOKEN: 'opsagent-e2e-enroll',
        OPSAGENT_PUBLIC_URL: 'http://127.0.0.1:18080',
        PORT: '18080',
      },
    },
    {
      command: 'pnpm --filter @opsagent/web exec vite --host 127.0.0.1 --port 15173',
      port: 15173,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_API_PROXY: 'http://127.0.0.1:18080',
      },
    },
  ],
});
