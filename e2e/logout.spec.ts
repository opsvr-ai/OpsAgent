import { expect, test } from '@playwright/test';

test('user can log out', async ({ page }) => {
  await page.goto('/');
  await page.locator('input').nth(0).fill('tenant-admin');
  await page.locator('input').nth(1).fill('opsagent-dev');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('tenant_admin').first()).toBeVisible();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible();
});
