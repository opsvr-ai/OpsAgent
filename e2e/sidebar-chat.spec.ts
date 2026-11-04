import { expect, test } from '@playwright/test';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.locator('input').nth(0).fill('tenant-admin');
  await page.locator('input').nth(1).fill('opsagent-dev');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('tenant_admin').first()).toBeVisible();
}

test('sidebar stays consistent across home, chat, and feature pages', async ({ page }) => {
  await login(page);
  const homeLabels = await page.locator('.sidebar .nav-item').allInnerTexts();

  await page.locator('.sidebar .nav-item').filter({ hasText: '智能体会话' }).click();
  await expect(page.getByRole('heading', { name: '运维会话' })).toBeVisible();
  const chatLabels = await page.locator('.sidebar .nav-item').allInnerTexts();
  expect(chatLabels).toEqual(homeLabels);

  await page.getByLabel('输入').fill('你好');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.locator('.msg.msg-user')).toContainText('你好');
  await expect(page.locator('.tool-card').first()).toBeVisible();

  await page.locator('.sidebar .nav-item').filter({ hasText: '事件指挥' }).click();
  await expect(page.getByRole('heading', { name: '事件指挥' })).toBeVisible();
  expect(await page.locator('.sidebar .nav-item').allInnerTexts()).toEqual(homeLabels);
});

test('tenant menu is a dropdown and keeps the brand visible', async ({ page }) => {
  await login(page);
  await page.locator('.sidebar .tenant-switch').click();
  await expect(page.locator('.tenant-menu')).toBeVisible();
  await expect(page.locator('.brand-name')).toBeVisible();
  await expect(page.locator('.tenant-menu').getByText('Demo Tenant')).toBeVisible();
});

test('composer exposes the four dsh permission modes', async ({ page }) => {
  await login(page);
  await page.locator('.sidebar .nav-item').filter({ hasText: '智能体会话' }).click();
  await expect(page.getByRole('heading', { name: '运维会话' })).toBeVisible();
  await page.getByRole('button', { name: /执行权限/ }).click();
  const menu = page.locator('.permission-menu');
  await expect(menu).toBeVisible();
  for (const label of ['仅可查看', '工作区内修改', '完全权限', '自动审查']) {
    await expect(menu.getByText(label, { exact: false }).first()).toBeVisible();
  }
  await menu.locator('.permission-option').filter({ hasText: '自动审查' }).click();
  await expect(page.getByRole('button', { name: /执行权限：自动审查/ })).toBeVisible();
});
