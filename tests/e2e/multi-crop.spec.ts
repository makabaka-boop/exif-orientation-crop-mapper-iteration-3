import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inverseMap } from '../../src/core/orientation';
import { mapRectToDisplay, mapRectToOriginal } from '../../src/core/crop';
import { unzip } from '../helpers/zip';

/**
 * 多裁片工作区 e2e：
 * - 保存裁片以原图坐标记录，切换方向后重投影显示；
 * - 同一快照打包 ZIP（PNG + 清单）；
 * - 迟到编码（生成期间换方向/改裁片/换图）不得交付旧包。
 *
 * 8×6 非对称测试图：R 编码 x，G 编码 y，可精确追踪每个像素。
 */
const RAW_W = 8;
const RAW_H = 6;
const FIXTURE_DIR = fileURLToPath(new URL('fixtures/', import.meta.url));
const FIXTURE = path.join(FIXTURE_DIR, 'multi.png');
const FIXTURE_2 = path.join(FIXTURE_DIR, 'multi-2.png');

function fixtureColor(x: number, y: number): [number, number, number, number] {
  return [10 + x * 30, 20 + y * 35, ((x + y * RAW_W) * 3 + 1) % 256, 255];
}

function writeFixture(file: string, w: number, h: number): void {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      png.data.set(fixtureColor(x, y), (y * w + x) * 4);
    }
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}

test.beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFixture(FIXTURE, RAW_W, RAW_H);
  writeFixture(FIXTURE_2, 5, 7); // 不同尺寸的第二张图，用于换图场景
});

/** 让 PNG 编码（canvas.toBlob）延迟完成，模拟「迟到编码」。 */
async function slowDownEncoding(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      setTimeout(() => original.call(this, callback, type, quality), 600);
    };
  });
}

async function dragRect(
  page: import('@playwright/test').Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const canvas = page.getByTestId('preview-canvas');
  await canvas.scrollIntoViewIfNeeded(); // 点击工作区按钮可能把画布滚出视口
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 5 });
  await page.mouse.up();
}

async function saveCrop(
  page: import('@playwright/test').Page,
  name: string,
): Promise<void> {
  await page.getByTestId('crop-name').fill(name);
  await page.getByTestId('save-crop').click();
}

const rectText = (r: { x: number; y: number; width: number; height: number }) =>
  `x=${r.x}, y=${r.y}, w=${r.width}, h=${r.height}`;

test('多裁片：原图坐标保存、换向重投影、同一快照打包 ZIP', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('preview-canvas')).toBeVisible();

  // 方向 1 下框选并保存裁片 alpha
  const alpha = { x: 1, y: 1, width: 3, height: 2 };
  await dragRect(page, { x: alpha.x, y: alpha.y }, { x: alpha.x + alpha.width, y: alpha.y + alpha.height });
  await saveCrop(page, 'alpha');
  await expect(page.getByTestId('crop-item-crop-1')).toBeVisible();
  await expect(page.getByTestId('crop-orig-crop-1')).toContainText(rectText(alpha));
  await expect(page.getByTestId('crop-count')).toHaveText('1/8');

  // 非法手势（单击零面积）不得覆盖已保存项
  await page.getByTestId('preview-canvas').scrollIntoViewIfNeeded();
  const box = (await page.getByTestId('preview-canvas').boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + 4);
  await expect(page.getByTestId('status')).toContainText('无效');
  await expect(page.getByTestId('crop-item-crop-1')).toBeVisible();
  await expect(page.getByTestId('crop-orig-crop-1')).toContainText(rectText(alpha));

  // 切换方向 6：已保存裁片按原图坐标重投影，而非沿用旧显示坐标
  await page.getByTestId('orientation-6').check();
  const alphaDisp6 = mapRectToDisplay(alpha, { width: RAW_W, height: RAW_H }, 6);
  await expect(page.getByTestId('crop-disp-crop-1')).toContainText(rectText(alphaDisp6));
  await expect(page.getByTestId('crop-orig-crop-1')).toContainText(rectText(alpha)); // 原图坐标不变
  await expect(page.getByTestId('saved-overlay-crop-1')).toBeVisible();

  // 方向 6（显示 6×8）下框选并保存裁片 beta
  const beta = { x: 1, y: 0, width: 2, height: 3 };
  await dragRect(page, { x: beta.x, y: beta.y }, { x: beta.x + beta.width, y: beta.y + beta.height });
  await saveCrop(page, 'beta');
  const betaOrig = mapRectToOriginal(beta, { width: RAW_W, height: RAW_H }, 6);
  await expect(page.getByTestId('crop-orig-crop-2')).toContainText(rectText(betaOrig));
  await expect(page.getByTestId('crop-disp-crop-2')).toContainText(rectText(beta));

  // 重名不得保存
  await page.getByTestId('crop-name').fill('alpha');
  await expect(page.getByTestId('save-crop')).toBeDisabled();

  // 打包：同一图片、方向 6、裁片列表快照 → ZIP
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-zip').click(),
  ]);
  expect(download.suggestedFilename()).toBe('multi-crops-o6.zip');
  const zipPath = await download.path();
  const entries = unzip(new Uint8Array(fs.readFileSync(zipPath!)));
  expect(entries.map((e) => e.name)).toEqual(['manifest.json', 'alpha.png', 'beta.png']);

  // 清单逐项绑定原图矩形、显示矩形与文件名
  const manifest = JSON.parse(new TextDecoder().decode(entries[0].data));
  expect(manifest.image).toMatchObject({ name: 'multi.png', width: RAW_W, height: RAW_H });
  expect(manifest.orientation).toBe(6);
  expect(manifest.crops).toHaveLength(2);
  expect(manifest.crops[0]).toMatchObject({ id: 'crop-1', name: 'alpha', file: 'alpha.png' });
  expect(manifest.crops[0].original.rect).toEqual(alpha);
  expect(manifest.crops[0].display.rect).toEqual(alphaDisp6);
  expect(manifest.crops[1]).toMatchObject({ id: 'crop-2', name: 'beta', file: 'beta.png' });
  expect(manifest.crops[1].original.rect).toEqual(betaOrig);
  expect(manifest.crops[1].display.rect).toEqual(beta);

  // 包内 PNG：正向、无缩放，与逆映射期望逐像素一致
  const checkPng = (data: Uint8Array, rect: typeof beta) => {
    const png = PNG.sync.read(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    expect(png.width).toBe(rect.width);
    expect(png.height).toBe(rect.height);
    for (let j = 0; j < rect.height; j++) {
      for (let i = 0; i < rect.width; i++) {
        const src = inverseMap(rect.x + i, rect.y + j, { width: RAW_W, height: RAW_H }, 6);
        const expected = fixtureColor(src.x, src.y);
        const p = (j * rect.width + i) * 4;
        expect(Array.from(png.data.slice(p, p + 4))).toEqual(expected);
      }
    }
  };
  checkPng(entries[1].data, alphaDisp6);
  checkPng(entries[2].data, beta);
});

test('迟到编码：打包期间改方向，整包不得下载', async ({ page }) => {
  await slowDownEncoding(page);
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('preview-canvas')).toBeVisible();

  await dragRect(page, { x: 0, y: 0 }, { x: 3, y: 2 });
  await saveCrop(page, 'alpha');

  let downloaded: string | null = null;
  page.on('download', (d) => {
    downloaded = d.suggestedFilename();
  });

  // 点击导出后、编码完成前切换方向 → 旧包作废
  await page.getByTestId('export-zip').click();
  await page.getByTestId('orientation-6').check();
  await expect(page.getByTestId('status')).toContainText('整包未下载');
  await page.waitForTimeout(1000); // 等迟到的编码全部结束
  expect(downloaded).toBeNull();

  // 状态恢复后：同一裁片在新方向下可重新交付
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-zip').click(),
  ]);
  expect(download.suggestedFilename()).toBe('multi-crops-o6.zip');
  const entries = unzip(new Uint8Array(fs.readFileSync((await download.path())!)));
  const manifest = JSON.parse(new TextDecoder().decode(entries[0].data));
  expect(manifest.orientation).toBe(6);
  expect(manifest.crops[0].original.rect).toEqual({ x: 0, y: 0, width: 3, height: 2 });
  expect(manifest.crops[0].display.rect).toEqual(
    mapRectToDisplay({ x: 0, y: 0, width: 3, height: 2 }, { width: RAW_W, height: RAW_H }, 6),
  );
});

test('迟到编码：打包期间删裁片，整包不得下载；换图清空裁片', async ({ page }) => {
  await slowDownEncoding(page);
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('preview-canvas')).toBeVisible();

  await dragRect(page, { x: 0, y: 0 }, { x: 2, y: 2 });
  await saveCrop(page, 'alpha');
  await dragRect(page, { x: 3, y: 3 }, { x: 6, y: 5 });
  await saveCrop(page, 'beta');
  await expect(page.getByTestId('crop-count')).toHaveText('2/8');

  let downloaded: string | null = null;
  page.on('download', (d) => {
    downloaded = d.suggestedFilename();
  });

  // 点击导出后、编码完成前删除一个裁片 → 旧包作废
  await page.getByTestId('export-zip').click();
  await page.getByTestId('remove-crop-crop-2').click();
  await expect(page.getByTestId('status')).toContainText('整包未下载');
  await page.waitForTimeout(1200);
  expect(downloaded).toBeNull();

  // 换图：清空已保存裁片，导出按钮不可用
  await page.getByTestId('file-input').setInputFiles(FIXTURE_2);
  await expect(page.getByTestId('display-size')).toContainText('原图 5×7');
  await expect(page.getByTestId('crop-count')).toHaveText('0/8');
  await expect(page.getByTestId('crop-empty')).toBeVisible();
  await expect(page.getByTestId('export-zip')).toBeDisabled();
});
