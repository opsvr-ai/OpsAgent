import { expect, test } from '@playwright/test';

const username = 'tenant-admin';
const password = 'opsagent-dev';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.locator('input').nth(0).fill(username);
  await page.locator('input').nth(1).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('tenant_admin').first()).toBeVisible();
}

test('design shell: light default, sidebar navigation, data and appearance pages', async ({ page }) => {
  await login(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.getByRole('button', { name: '数据沉淀' }).click();
  await expect(page.getByRole('heading', { name: '插件数据沉淀' })).toBeVisible();
  await expect(page.getByText('存储占用')).toBeVisible();
  await expect(page.getByText('数据存储加载失败')).toHaveCount(0);

  await page.getByRole('button', { name: '外观与主题' }).click();
  await expect(page.getByRole('heading', { name: '外观与主题' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '生效优先级' })).toBeVisible();

  await page.getByRole('button', { name: '工作台' }).first().click();
  await expect(page.getByRole('button', { name: '新建会话' })).toBeVisible();
});
