import { expect, test } from '@playwright/test';

const username = 'tenant-admin';
const password = 'opsagent-dev';

test('all sidebar pages render without console or page errors', async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const location = message.location();
      consoleErrors.push(`${message.text()} @ ${location.url ?? 'unknown'}`);
    }
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page.locator('input').nth(0).fill(username);
  await page.locator('input').nth(1).fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByText('tenant_admin').first()).toBeVisible();

  async function assertLayout(): Promise<void> {
    const layout = await page.evaluate(() => {
      const oversizedDetail: string[] = [];
      const oversized = Array.from(document.querySelectorAll('svg')).filter((svg) => {
        // 业务画布/拓扑图/迷你地图是数据可视化，不是图标，不参与「超大图标」断言。
        if (svg.getAttribute('role') === 'application' || svg.getAttribute('role') === 'img') return false;
        if (svg.closest('[class*="topo-canvas"], [class*="topo-minimap"], [class*="topology-canvas"], [class*="topology-minimap"]')) return false;
        const box = svg.getBoundingClientRect();
        if (box.width <= 48 && box.height <= 48) return false;
        oversizedDetail.push(`${svg.getAttribute('class') ?? svg.getAttribute('aria-label') ?? 'svg'} ${Math.round(box.width)}x${Math.round(box.height)}`);
        return true;
      }).length;
      return {
        oversized,
        oversizedDetail,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    const title = (await page.locator('h1').first().textContent().catch(() => '')) ?? '';
    expect(layout.oversized, `no oversized SVG icons on "${title}": ${layout.oversizedDetail.join(' | ')}`).toBe(0);
    expect(layout.horizontalOverflow, 'no horizontal page overflow').toBe(false);
  }

  await assertLayout();

  const nav = page.locator('.sidebar .nav-item');
  await nav.nth(13).click();
  await expect(page.locator('h1')).toBeVisible();
  await assertLayout();
  const count = await nav.count();
  expect(count).toBeGreaterThanOrEqual(17);

  const titles: string[] = [];
  for (let index = 1; index < count; index += 1) {
    await nav.nth(index).click();
    await expect(page.locator('h1')).toBeVisible({ timeout: 10_000 });
    titles.push((await page.locator('h1').first().textContent({ timeout: 5_000 }) ?? '').trim());
    await assertLayout();
    await expect(page.getByRole('alert').filter({ hasText: '加载失败' })).toHaveCount(0);
  }

  expect(new Set(titles).size).toBe(titles.length);
  expect(pageErrors).toEqual([]);
  const unexpected = consoleErrors.filter((entry) => !entry.includes('/api/me'));
  expect(unexpected).toEqual([]);
});
