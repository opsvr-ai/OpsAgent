/**
 * 用 Playwright（本机 Edge/Chrome channel）打开 OpsAgent 页面，可选登录、点击左侧导航、
 * 截图，并做一轮轻量可读性审计（溢出/截断/小字号/过小点击区）。
 *
 * 用法：
 *   node scripts/screenshot-topology.mjs <url> <out.png> <width> <height> [--full] [--login] [--nav=访问拓扑] [--audit] [--dark]
 * 例：
 *   node scripts/screenshot-topology.mjs "http://127.0.0.1:5174/?demo=topology" .dsh-runtime/topology.png 1680 1004 --full
 *   node scripts/screenshot-topology.mjs "http://127.0.0.1:5174/" .dsh-runtime/topology-live.png 1680 1004 --login --nav=访问拓扑 --full --audit
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = process.argv.slice(2).filter((item) => !item.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((item) => item.startsWith('--')));
const flagValue = (name, fallback) => {
  const match = [...flags].find((item) => item.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
};
const url = args[0] ?? 'http://127.0.0.1:5174/?demo=topology';
const out = args[1] ?? '.dsh-runtime/topology-shot.png';
const width = Number.parseInt(args[2] ?? '1680', 10);
const height = Number.parseInt(args[3] ?? '1004', 10);
const fullPage = flags.has('--full');
const dark = flags.has('--dark');
const audit = flags.has('--audit');
const login = flags.has('--login');
const nav = flagValue('nav', '');
const clicks = flagValue('clicks', '').split('||').map((item) => item.trim()).filter(Boolean);

mkdirSync(dirname(out), { recursive: true });

const channel = process.env.PLAYWRIGHT_CHANNEL ?? 'msedge';
const browser = await chromium.launch({ channel, headless: true, args: ['--disable-gpu'] });
const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: 1,
  colorScheme: dark ? 'dark' : 'light',
  locale: 'zh-CN',
});
const errors = [];
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console.error: ${message.text().slice(0, 300)}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message.slice(0, 300)}`));
page.on('requestfailed', (request) => {
  if (request.url().includes('favicon')) return;
  const failure = request.failure();
  errors.push(`requestfailed: ${request.url()} ${failure ? failure.errorText : 'unknown'}`);
});
page.on('response', (response) => {
  if (response.status() >= 400 && !response.url().includes('favicon')) {
    errors.push(`http-${response.status()}: ${response.url()}`);
  }
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
await page.waitForTimeout(1800);

if (login) {
  if (await page.locator('#username').count()) {
    await page.fill('#username', process.env.OPSAGENT_USER ?? 'tenant-admin');
    await page.fill('#password', process.env.OPSAGENT_PASSWORD ?? 'opsagent-dev');
    const remember = page.locator('input[type="checkbox"]').first();
    if (await remember.count()) await remember.check().catch(() => undefined);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(3000);
  }
}
if (nav) {
  const target = page.getByText(nav, { exact: true }).first();
  if (await target.count()) {
    await target.click();
    await page.waitForTimeout(2500);
  }
}
for (const clickText of clicks) {
  const target = page.getByText(clickText, { exact: true }).first();
  if (await target.count()) {
    await target.click();
    await page.waitForTimeout(1800);
  } else {
    errors.push(`click-target-not-found: ${clickText}`);
  }
}
await page.waitForTimeout(1500);
await page.evaluate(() => document.fonts?.ready ?? null);

const auditResult = audit
  ? await page.evaluate(() => {
      const issues = [];
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none'
          && Number(style.opacity) > 0.05 && rect.width > 0 && rect.height > 0;
      };
      const label = (el) => {
        const id = el.id ? `#${el.id}` : '';
        const cls = typeof el.className === 'string' && el.className
          ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
          : '';
        return `${el.tagName.toLowerCase()}${id}${cls}`;
      };
      for (const el of document.querySelectorAll('body *')) {
        if (!visible(el)) continue;
        const style = getComputedStyle(el);
        const ownText = [...el.childNodes]
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent.trim())
          .join(' ')
          .trim();
        if (ownText && (el.scrollWidth > el.clientWidth + 2 || el.scrollHeight > el.clientHeight + 2)) {
          issues.push({ kind: 'overflow', selector: label(el), text: ownText.slice(0, 60), sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight });
        }
        if (ownText) {
          const size = Number.parseFloat(style.fontSize);
          if (size < 11) issues.push({ kind: 'small-font', selector: label(el), text: ownText.slice(0, 40), fontSize: size });
        }
        if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
          const rect = el.getBoundingClientRect();
          if (rect.width < 24 || rect.height < 24) issues.push({ kind: 'tiny-target', selector: label(el), text: (el.textContent ?? '').trim().slice(0, 30), w: Math.round(rect.width), h: Math.round(rect.height) });
        }
      }
      const doc = document.documentElement;
      return {
        viewport: { width: innerWidth, height: innerHeight },
        page: { scrollWidth: doc.scrollWidth, scrollHeight: doc.scrollHeight },
        overflowX: doc.scrollWidth > innerWidth + 2,
        issues: issues.slice(0, 60),
        issueCount: issues.length,
      };
    })
  : null;

await page.screenshot({ path: out, fullPage });
const title = await page.title();
const bodyText = (await page.locator('body').innerText().catch(() => '')).slice(0, 500);
await browser.close();

console.log(JSON.stringify({ url, out, width, height, fullPage, title, bodyText, auditResult, errors }, null, 2));
if (errors.length > 0) process.exitCode = 2;
