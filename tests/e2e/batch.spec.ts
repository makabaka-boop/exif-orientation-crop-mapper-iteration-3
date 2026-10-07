import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inverseMap } from '../../src/core/orientation';
import { mapRectToOriginal } from '../../src/core/crop';
import { mapRectToDisplay } from '../../src/core/batch';
import { MANIFEST_FILE_NAME } from '../../src/core/delivery';
import { readZip } from '../../src/core/zip';

/**
 * 8×6 非对称测试图：每个像素颜色唯一，
 * R 编码 x，G 编码 y，可精确追踪每个像素的去向。
 */
const RAW_W = 8;
const RAW_H = 6;
const RAW_SIZE = { width: RAW_W, height: RAW_H };
const FIXTURE_DIR = fileURLToPath(new URL('fixtures/', import.meta.url));
const FIXTURE = path.join(FIXTURE_DIR, 'photo.png');
const FIXTURE2 = path.join(FIXTURE_DIR, 'photo2.png');

function fixtureColor(x: number, y: number): [number, number, number, number] {
  return [10 + x * 30, 20 + y * 35, ((x + y * RAW_W) * 3 + 1) % 256, 255];
}

function writeFixture(file: string, width: number, height: number): void {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      png.data.set(fixtureColor(x, y), (y * width + x) * 4);
    }
  }
  fs.writeFileSync(file, PNG.sync.write(png));
}

test.beforeAll(() => {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFixture(FIXTURE, RAW_W, RAW_H);
  writeFixture(FIXTURE2, 5, 4); // 另一张尺寸不同的图，用于「换图」场景
});

/** 在预览画布上按显示图像素边界拖出矩形。 */
async function dragRect(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  const box = (await page.getByTestId('preview-canvas').boundingBox())!;
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 5 });
  await page.mouse.up();
}

/** 断言某个已保存裁片的 overlay 与画布 1:1 对齐到期望显示矩形。 */
async function expectOverlayRect(
  page: Page,
  cropId: string,
  rect: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const canvasBox = (await page.getByTestId('preview-canvas').boundingBox())!;
  const overlayBox = (await page.getByTestId(`saved-overlay-${cropId}`).boundingBox())!;
  expect(Math.round(overlayBox.x - canvasBox.x)).toBe(rect.x);
  expect(Math.round(overlayBox.y - canvasBox.y)).toBe(rect.y);
  expect(Math.round(overlayBox.width)).toBe(rect.width);
  expect(Math.round(overlayBox.height)).toBe(rect.height);
}

/** 期望的裁切像素：从原始像素经逆映射逐像素计算。 */
function expectedPixels(rect: { x: number; y: number; width: number; height: number }, o: number) {
  const out: number[] = [];
  for (let j = 0; j < rect.height; j++) {
    for (let i = 0; i < rect.width; i++) {
      const src = inverseMap(rect.x + i, rect.y + j, RAW_SIZE, o as 1);
      out.push(...fixtureColor(src.x, src.y));
    }
  }
  return out;
}

test('多裁片工作区：保存 → 换方向重投影 → 导出 ZIP（清单逐项绑定）', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('preview-canvas')).toBeVisible();

  // 方向 6（顺时针 90°）下框选并保存第一个裁片
  await page.getByTestId('orientation-6').check();
  const rectA = { x: 1, y: 1, width: 3, height: 4 };
  await dragRect(
    page,
    { x: rectA.x, y: rectA.y },
    { x: rectA.x + rectA.width, y: rectA.y + rectA.height },
  );
  await page.getByTestId('crop-name').fill('alpha');
  await page.getByTestId('save-crop').click();
  const originalA = mapRectToOriginal(rectA, RAW_SIZE, 6);
  const rowA = page.getByTestId('saved-crop-crop-1');
  await expect(rowA).toContainText('alpha');
  await expect(rowA).toContainText(
    `显示 x=${rectA.x}, y=${rectA.y}, w=${rectA.width}, h=${rectA.height}`,
  );
  await expect(rowA).toContainText(
    `原图 x=${originalA.x}, y=${originalA.y}, w=${originalA.width}, h=${originalA.height}`,
  );
  await expectOverlayRect(page, 'crop-1', rectA);

  // 切换方向 2（水平镜像）：裁片必须按原图坐标重新投影，
  // 而不是把方向 6 下的旧显示坐标直接套过来
  await page.getByTestId('orientation-2').check();
  const projectedA = mapRectToDisplay(originalA, RAW_SIZE, 2);
  expect(projectedA).not.toEqual(rectA); // 确实发生了重投影
  await expect(rowA).toContainText(
    `显示 x=${projectedA.x}, y=${projectedA.y}, w=${projectedA.width}, h=${projectedA.height}`,
  );
  await expect(rowA).toContainText(
    `原图 x=${originalA.x}, y=${originalA.y}, w=${originalA.width}, h=${originalA.height}`,
  );
  await expectOverlayRect(page, 'crop-1', projectedA);

  // 方向 2 下再保存第二个裁片
  const rectB = { x: 0, y: 4, width: 2, height: 2 };
  await dragRect(
    page,
    { x: rectB.x, y: rectB.y },
    { x: rectB.x + rectB.width, y: rectB.y + rectB.height },
  );
  await page.getByTestId('crop-name').fill('beta');
  await page.getByTestId('save-crop').click();
  const originalB = mapRectToOriginal(rectB, RAW_SIZE, 2);
  await expect(page.getByTestId('saved-crop-crop-2')).toContainText('beta');
  await expectOverlayRect(page, 'crop-2', rectB);

  // 导出 ZIP：同一图片、方向与裁片列表的快照
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('export-zip').click(),
  ]);
  expect(download.suggestedFilename()).toBe('photo-crops-o2.zip');
  const zip = readZip(new Uint8Array(fs.readFileSync((await download.path())!)));
  expect(zip.map((e) => e.name)).toEqual(['01-alpha.png', '02-beta.png', MANIFEST_FILE_NAME]);

  // 清单：逐项绑定裁片身份、原图矩形、显示矩形与包内文件名
  const manifest = JSON.parse(new TextDecoder().decode(zip[2].data));
  expect(manifest.image).toMatchObject({ name: 'photo.png', width: RAW_W, height: RAW_H });
  expect(manifest.orientation).toBe(2);
  expect(manifest.crops).toHaveLength(2);
  expect(manifest.crops[0]).toMatchObject({
    id: 'crop-1',
    name: 'alpha',
    file: '01-alpha.png',
    display: { rect: projectedA },
    original: { rect: originalA },
  });
  expect(manifest.crops[1]).toMatchObject({
    id: 'crop-2',
    name: 'beta',
    file: '02-beta.png',
    display: { rect: rectB },
    original: { rect: originalB },
  });
  for (const entry of manifest.crops) {
    expect(entry.original.corners).toHaveLength(4);
  }

  // 包内 PNG：正向无缩放，与预览同一区域逐像素一致
  const pngA = PNG.sync.read(Buffer.from(zip[0].data));
  expect([pngA.width, pngA.height]).toEqual([projectedA.width, projectedA.height]);
  expect(Array.from(pngA.data)).toEqual(expectedPixels(projectedA, 2));
  const pngB = PNG.sync.read(Buffer.from(zip[1].data));
  expect([pngB.width, pngB.height]).toEqual([rectB.width, rectB.height]);
  expect(Array.from(pngB.data)).toEqual(expectedPixels(rectB, 2));
});

test('迟到的编码不会交付旧包：打包期间改方向，整包作废', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('preview-canvas')).toBeVisible();
  await dragRect(page, { x: 0, y: 0 }, { x: 2, y: 2 });
  await page.getByTestId('crop-name').fill('alpha');
  await page.getByTestId('save-crop').click();

  // 挂上编码闸门：打包会在第一个裁片编码前停下
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__encodeGate = new Promise((resolve) => {
      w.__releaseEncode = resolve;
    });
    w.__exifCropEncodeHook = () => {
      w.__hookEntered = true;
      return w.__encodeGate;
    };
  });

  let downloaded = false;
  page.on('download', () => {
    downloaded = true;
  });
  await page.getByTestId('export-zip').click();
  await page.waitForFunction(() => (window as never as { __hookEntered?: boolean }).__hookEntered);

  // 编码被闸住期间改变方向 → 快照失效
  await page.getByTestId('orientation-3').check();
  await page.evaluate(() => (window as never as { __releaseEncode: () => void }).__releaseEncode());

  await expect(page.getByTestId('status')).toContainText('整包未下载');
  await expect(page.getByTestId('export-zip')).toBeEnabled(); // 打包状态已复位
  await page.waitForTimeout(500);
  expect(downloaded).toBe(false);
});

test('迟到的编码不会交付旧包：打包期间改裁片，整包作废', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('preview-canvas')).toBeVisible();
  await dragRect(page, { x: 0, y: 0 }, { x: 2, y: 2 });
  await page.getByTestId('crop-name').fill('alpha');
  await page.getByTestId('save-crop').click();

  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__encodeGate = new Promise((resolve) => {
      w.__releaseEncode = resolve;
    });
    w.__exifCropEncodeHook = () => {
      w.__hookEntered = true;
      return w.__encodeGate;
    };
  });

  let downloaded = false;
  page.on('download', () => {
    downloaded = true;
  });
  await page.getByTestId('export-zip').click();
  await page.waitForFunction(() => (window as never as { __hookEntered?: boolean }).__hookEntered);

  // 编码被闸住期间删除裁片 → 快照失效
  await page.getByTestId('remove-crop-crop-1').click();
  await page.evaluate(() => (window as never as { __releaseEncode: () => void }).__releaseEncode());

  await expect(page.getByTestId('status')).toContainText('整包未下载');
  await page.waitForTimeout(500);
  expect(downloaded).toBe(false);
});

test('状态规则：非法手势不覆盖已保存裁片，换图清空裁片', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await expect(page.getByTestId('preview-canvas')).toBeVisible();
  await dragRect(page, { x: 1, y: 1 }, { x: 4, y: 4 });
  await page.getByTestId('crop-name').fill('alpha');
  await page.getByTestId('save-crop').click();
  await expect(page.getByTestId('saved-crop-crop-1')).toBeVisible();

  // 单击产生零面积矩形：非法手势，已保存裁片不受影响
  const box = (await page.getByTestId('preview-canvas').boundingBox())!;
  await page.mouse.click(box.x + 3, box.y + 3);
  await expect(page.getByTestId('status')).toContainText('无效');
  await expect(page.getByTestId('saved-crop-crop-1')).toBeVisible();
  await expect(page.getByTestId('save-crop')).toBeDisabled(); // 当前框选非法，不能再保存
  await expect(page.getByTestId('export-zip')).toBeEnabled(); // 已有裁片仍可交付

  // 换图：旧裁片（原图坐标）全部清空
  await page.getByTestId('file-input').setInputFiles(FIXTURE2);
  await expect(page.getByTestId('display-size')).toContainText('原图 5×4');
  await expect(page.locator('[data-testid^="saved-crop-"]')).toHaveCount(0);
  await expect(page.getByTestId('export-zip')).toBeDisabled();
});
