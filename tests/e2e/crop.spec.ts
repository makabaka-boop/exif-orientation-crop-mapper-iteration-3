import { expect, test } from '@playwright/test';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inverseMap, orientedSize } from '../../src/core/orientation';
import { mapRectToOriginal } from '../../src/core/crop';

/**
 * 8×6 非对称测试图：每个像素颜色唯一，
 * R 编码 x，G 编码 y，可精确追踪每个像素的去向。
 */
const RAW_W = 8;
const RAW_H = 6;
const FIXTURE_DIR = fileURLToPath(new URL('fixtures/', import.meta.url));
const FIXTURE = path.join(FIXTURE_DIR, 'photo.png');

function fixtureColor(x: number, y: number): [number, number, number, number] {
  return [10 + x * 30, 20 + y * 35, ((x + y * RAW_W) * 3 + 1) % 256, 255];
}

test.beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const png = new PNG({ width: RAW_W, height: RAW_H });
  for (let y = 0; y < RAW_H; y++) {
    for (let x = 0; x < RAW_W; x++) {
      png.data.set(fixtureColor(x, y), (y * RAW_W + x) * 4);
    }
  }
  fs.writeFileSync(FIXTURE, PNG.sync.write(png));
});

/** 读取当前预览画布上指定矩形区域的像素。 */
function readPreviewPixels(
  page: import('@playwright/test').Page,
  rect: { x: number; y: number; width: number; height: number },
): Promise<number[]> {
  return page.evaluate((r) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="preview-canvas"]')!;
    const ctx = canvas.getContext('2d')!;
    return Array.from(ctx.getImageData(r.x, r.y, r.width, r.height).data);
  }, rect);
}

/** 在预览画布上按显示图像素边界拖出矩形。 */
async function dragRect(
  page: import('@playwright/test').Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const box = (await page.getByTestId('preview-canvas').boundingBox())!;
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 5 });
  await page.mouse.up();
}

test('选图 → 选方向 5（镜像+旋转）→ 裁切 → 导出：文件与预览逐像素一致', async ({ page }) => {
  await page.goto('/');

  // 1. 选择本地图片
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('preview-canvas')).toBeVisible();
  await expect(page.getByTestId('display-size')).toHaveText(`原图 ${RAW_W}×${RAW_H} → 显示 ${RAW_W}×${RAW_H}`);

  // 2. 选择 EXIF 方向 5（主对角翻转：同时包含镜像与旋转）
  const orientation = 5;
  await page.getByTestId(`orientation-${orientation}`).check();
  const display = orientedSize({ width: RAW_W, height: RAW_H }, orientation);
  await expect(page.getByTestId('display-size')).toHaveText(
    `原图 ${RAW_W}×${RAW_H} → 显示 ${display.width}×${display.height}`,
  );
  const canvasBox = await page.getByTestId('preview-canvas').boundingBox();
  expect(canvasBox!.width).toBe(display.width);
  expect(canvasBox!.height).toBe(display.height);

  // 3. 在正向预览上拖出整像素边界的半开矩形 [2,1) → [5,5)
  const rect = { x: 2, y: 1, width: 3, height: 4 };
  await dragRect(page, { x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height });
  await expect(page.getByTestId('display-rect')).toContainText(
    `x=${rect.x}, y=${rect.y}, w=${rect.width}, h=${rect.height}`,
  );

  // 期望：从原始像素经逆映射逐像素计算
  const expectedOriginal = mapRectToOriginal(rect, { width: RAW_W, height: RAW_H }, orientation);
  await expect(page.getByTestId('original-rect')).toContainText(
    `x=${expectedOriginal.x}, y=${expectedOriginal.y}, w=${expectedOriginal.width}, h=${expectedOriginal.height}`,
  );
  const expectedPixels: number[] = [];
  for (let j = 0; j < rect.height; j++) {
    for (let i = 0; i < rect.width; i++) {
      const src = inverseMap(rect.x + i, rect.y + j, { width: RAW_W, height: RAW_H }, orientation);
      expectedPixels.push(...fixtureColor(src.x, src.y));
    }
  }

  // 摄影师在预览上看到的裁切区域
  const previewPixels = await readPreviewPixels(page, rect);
  expect(previewPixels).toEqual(expectedPixels);

  // 4. 导出 PNG：下载文件内容必须与预览逐像素一致
  const [pngDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-png').click(),
  ]);
  const pngPath = await pngDownload.path();
  const exported = PNG.sync.read(fs.readFileSync(pngPath!));
  expect(exported.width).toBe(rect.width);
  expect(exported.height).toBe(rect.height);
  expect(Array.from(exported.data)).toEqual(previewPixels);
  expect(Array.from(exported.data)).toEqual(expectedPixels);

  // 5. 导出 JSON：同一映射给出的原图坐标
  const [jsonDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-json').click(),
  ]);
  const jsonPath = await jsonDownload.path();
  const meta = JSON.parse(fs.readFileSync(jsonPath!, 'utf8'));
  expect(meta.orientation).toBe(orientation);
  expect(meta.image).toMatchObject({ width: RAW_W, height: RAW_H, name: 'photo.png' });
  expect(meta.display.rect).toEqual(rect);
  expect(meta.original.rect).toEqual(expectedOriginal);
  expect(meta.original.corners).toHaveLength(4);
  for (const corner of meta.original.corners) {
    const src = inverseMap(corner.u, corner.v, { width: RAW_W, height: RAW_H }, orientation);
    expect({ x: corner.x, y: corner.y }).toEqual(src);
  }
});

test('非法矩形与方向/图片变更：保留图片但拒绝下载，旧状态失效', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('preview-canvas')).toBeVisible();

  // 有效裁切后按钮可用
  await page.getByTestId('orientation-6').check();
  await dragRect(page, { x: 1, y: 1 }, { x: 4, y: 5 });
  await expect(page.getByTestId('export-png')).toBeEnabled();

  // 方向变更：旧裁切失效，按钮禁用，图片仍在
  await page.getByTestId('orientation-8').check();
  await expect(page.getByTestId('export-png')).toBeDisabled();
  await expect(page.getByTestId('export-json')).toBeDisabled();
  await expect(page.getByTestId('status')).toContainText('方向已变更');
  const size = orientedSize({ width: RAW_W, height: RAW_H }, 8);
  await expect(page.getByTestId('display-size')).toHaveText(
    `原图 ${RAW_W}×${RAW_H} → 显示 ${size.width}×${size.height}`,
  );

  // 单击产生零面积矩形：非法，保留当前图片但不给下载
  const box = (await page.getByTestId('preview-canvas').boundingBox())!;
  await page.mouse.click(box.x + 3, box.y + 3);
  await expect(page.getByTestId('export-png')).toBeDisabled();
  await expect(page.getByTestId('export-json')).toBeDisabled();
  await expect(page.getByTestId('status')).toContainText('无效');
  await expect(page.getByTestId('preview-canvas')).toBeVisible();
  await expect(page.getByTestId('display-size')).toContainText(`显示 ${size.width}×${size.height}`);
});
