import { expect, test } from '@playwright/test';

test('agent page generates one-click install commands', async ({ page }) => {
  await page.goto('/');
  await page.locator('input').nth(0).fill('tenant-admin');
  await page.locator('input').nth(1).fill('opsagent-dev');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByText('tenant_admin').first()).toBeVisible();

  await page.locator('.sidebar .nav-item').filter({ hasText: '服务器 Agent' }).click();
  await expect(page.getByRole('heading', { name: '服务器 Agent' })).toBeVisible();
  await page.getByRole('button', { name: '一键安装 Agent' }).click();
  await expect(page.getByRole('heading', { name: '一键安装命令' })).toBeVisible();
  await expect(page.getByText(/api\/agents\/install\.sh/)).toBeVisible();
  await expect(page.getByText(/api\/agents\/install\.ps1/)).toBeVisible();
});
