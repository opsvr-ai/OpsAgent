import { expect, test } from '@playwright/test';

test('platform admin can log in without a tenant', async ({ page }) => {
  await page.goto('/');
  await page.locator('input').nth(0).fill('platform-admin');
  await page.locator('input').nth(1).fill('opsagent-dev');
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: '平台租户管理' })).toBeVisible();
  await expect(page.getByText('Demo Tenant')).toBeVisible();
});
