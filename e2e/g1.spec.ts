import { expect, test } from '@playwright/test';

const username = 'tenant-admin';
const password = 'opsagent-dev';

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page.getByRole('heading', { name: 'tenant_admin' })).toBeVisible();
}

test('G1: login -> home -> session -> mock echo', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '进入会话' }).click();
  await page.getByLabel('输入').fill('echo hello');
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.getByText('checking: echo hello')).toBeVisible();
  await expect(page.getByText('mock.echo').first()).toBeVisible();
  await expect(page.getByText('完成')).toBeVisible();
});

test('G1: mock.restart requires approval', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '进入会话' }).click();
  await page.getByLabel('输入').fill('restart service');
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.getByRole('button', { name: '批准' })).toBeVisible();
  await page.getByRole('button', { name: '批准' }).click();
  await expect(page.getByText('mock.restart').first()).toBeVisible();
  await expect(page.getByText('完成')).toBeVisible();
});
