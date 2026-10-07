import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { PixelImage, Rect } from '../../src/core/orientation';
import { mapRectToOriginal } from '../../src/core/crop';
import { CropItem, createCropItem, displayRectForCrop } from '../../src/core/crops';
import {
  MANIFEST_FILE,
  buildCropPackage,
  buildPackageManifest,
  cropFileName,
} from '../../src/core/package';
import { buildZip, crc32 } from '../../src/core/zip';
import { unzip } from '../helpers/zip';
import { ALL_ORIENTATIONS, Color, EXPECTED, RAW_SIZE, makeRaw, toRows } from '../helpers/matrix';

/** 测试用 PNG 编码器（浏览器端等价物为 canvas.toBlob）。 */
async function encodePng(img: PixelImage): Promise<Uint8Array> {
  const png = new PNG({ width: img.width, height: img.height });
  Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength).copy(png.data);
  const buf: Buffer = PNG.sync.write(png);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** 解码 PNG 字节并读回颜色矩阵。 */
function decodeRows(bytes: Uint8Array): Color[][] {
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return toRows({ width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) });
}

const FILE = { name: 'photo.png', type: 'image/png' };

/** 以显示矩形声明裁片（模拟用户在预览上框选后保存）。 */
function save(id: string, name: string, displayRect: Rect, o: Parameters<typeof createCropItem>[4]): CropItem {
  return createCropItem(id, name, displayRect, RAW_SIZE, o);
}

describe('ZIP 写入器', () => {
  it('CRC-32 标准向量', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('打包后可完整读回：名称、字节、CRC 一致', () => {
    const entries = [
      { name: 'manifest.json', data: new TextEncoder().encode('{"a":1}') },
      { name: '裁片-甲.png', data: new Uint8Array([1, 2, 3, 250, 0, 255]) },
      { name: 'b.png', data: new Uint8Array(0) },
    ];
    const out = unzip(buildZip(entries));
    expect(out.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    entries.forEach((e, i) => expect(Array.from(out[i].data)).toEqual(Array.from(e.data)));
  });

  it('同一输入产出逐字节一致（固定时间戳）', () => {
    const entries = [{ name: 'a.bin', data: new Uint8Array([7, 8, 9]) }];
    expect(Array.from(buildZip(entries))).toEqual(Array.from(buildZip(entries)));
  });
});

describe('交付清单：逐项绑定原图、显示矩形与文件名', () => {
  it.each(ALL_ORIENTATIONS)('方向 %i：清单矩形与核心映射一致', (o) => {
    const [w, h] = EXPECTED[o].size;
    const displayRect: Rect = { x: 0, y: 0, width: 1, height: h };
    const items = [save('crop-1', 'strip', displayRect, o)];
    const manifest = buildPackageManifest(RAW_SIZE, FILE, o, items);

    expect(manifest.image).toEqual({ name: 'photo.png', type: 'image/png', width: 3, height: 2 });
    expect(manifest.orientation).toBe(o);
    expect(manifest.crops).toHaveLength(1);
    const entry = manifest.crops[0];
    expect(entry.id).toBe('crop-1');
    expect(entry.name).toBe('strip');
    expect(entry.file).toBe('strip.png');
    expect(entry.display).toEqual({ width: w, height: h, rect: displayRect });
    expect(entry.original.rect).toEqual(mapRectToOriginal(displayRect, RAW_SIZE, o));
    expect(entry.original.corners).toHaveLength(4);
  });

  it('跨方向保存后重投影：清单显示矩形不等于旧方向显示坐标', () => {
    // 方向 1 下保存左列；在方向 2（水平镜像）下交付
    const items = [save('crop-1', 'left', { x: 0, y: 0, width: 1, height: 2 }, 1)];
    const manifest = buildPackageManifest(RAW_SIZE, FILE, 2, items);
    const entry = manifest.crops[0];
    expect(entry.original.rect).toEqual({ x: 0, y: 0, width: 1, height: 2 });
    // 重投影到镜像后的显示图右列，而不是沿用保存时的 x=0
    expect(entry.display.rect).toEqual({ x: 2, y: 0, width: 1, height: 2 });
    expect(entry.display.rect).not.toEqual({ x: 0, y: 0, width: 1, height: 2 });
  });
});

describe('打包：同一图片、方向与裁片列表快照 → ZIP', () => {
  it('镜像方向 2：包内 PNG 逐像素等于期望矩阵切片，清单可复核', async () => {
    const o = 2;
    // 显示图（镜像后）[[C,B,A],[F,E,D]]：左列竖条 + 底行横条
    const items = [
      save('crop-1', 'left-col', { x: 0, y: 0, width: 1, height: 2 }, o),
      save('crop-2', 'bottom-row', { x: 0, y: 1, width: 3, height: 1 }, o),
    ];
    const result = await buildCropPackage(makeRaw(), FILE, o, items, encodePng);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const entries = unzip(result.zip);
    expect(entries.map((e) => e.name)).toEqual([MANIFEST_FILE, 'left-col.png', 'bottom-row.png']);

    // 清单与包内文件名一一对应
    const manifest = JSON.parse(new TextDecoder().decode(entries[0].data));
    expect(manifest.orientation).toBe(2);
    expect(manifest.crops.map((c: { file: string }) => c.file)).toEqual([
      'left-col.png',
      'bottom-row.png',
    ]);
    expect(manifest.crops[0]).toMatchObject({
      id: 'crop-1',
      name: 'left-col',
      original: { rect: { x: 2, y: 0, width: 1, height: 2 } }, // 镜像：显示左列 ↔ 原图右列
      display: { rect: { x: 0, y: 0, width: 1, height: 2 } },
    });
    expect(manifest.crops[1]).toMatchObject({
      id: 'crop-2',
      original: { rect: { x: 0, y: 1, width: 3, height: 2 - 1 } },
      display: { rect: { x: 0, y: 1, width: 3, height: 1 } },
    });

    // 包内 PNG 像素 = 期望矩阵的对应切片（正向、无缩放）
    expect(decodeRows(entries[1].data)).toEqual([[EXPECTED[2].rows[0][0]], [EXPECTED[2].rows[1][0]]]);
    expect(decodeRows(entries[2].data)).toEqual([EXPECTED[2].rows[1]]);
  });

  it('旋转方向 6：跨方向保存的裁片重投影后打包', async () => {
    // 裁片在方向 1 下保存（显示 3×2），交付时方向为 6（显示 2×3）
    const items = [
      save('crop-1', 'top', { x: 0, y: 0, width: 3, height: 1 }, 1), // 原图顶行 A B C
      save('crop-2', 'bl', { x: 0, y: 1, width: 1, height: 1 }, 1), // 原图左下 D
    ];
    const result = await buildCropPackage(makeRaw(), FILE, 6, items, encodePng);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const entries = unzip(result.zip);
    const manifest = JSON.parse(new TextDecoder().decode(entries[0].data));

    // 方向 6 显示矩阵 [[D,A],[E,B],[F,C]]：原图顶行 → 显示右列
    expect(manifest.crops[0].original.rect).toEqual({ x: 0, y: 0, width: 3, height: 1 });
    expect(manifest.crops[0].display.rect).toEqual({ x: 1, y: 0, width: 1, height: 3 });
    expect(decodeRows(entries[1].data)).toEqual([
      [EXPECTED[6].rows[0][1]],
      [EXPECTED[6].rows[1][1]],
      [EXPECTED[6].rows[2][1]],
    ]);

    // 原图左下 D → 方向 6 显示图左上角
    expect(manifest.crops[1].display.rect).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(decodeRows(entries[2].data)).toEqual([[EXPECTED[6].rows[0][0]]]);
  });

  it.each(ALL_ORIENTATIONS)('方向 %i：整幅裁片的包内 PNG 等于期望矩阵', async (o) => {
    const [w, h] = EXPECTED[o].size;
    const items = [save('crop-1', 'full', { x: 0, y: 0, width: w, height: h }, o)];
    const result = await buildCropPackage(makeRaw(), FILE, o, items, encodePng);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entries = unzip(result.zip);
    expect(decodeRows(entries[1].data)).toEqual(EXPECTED[o].rows);
  });

  it('清单显示矩形与 PNG 像素同源（displayRectForCrop）', async () => {
    const o = 5;
    const items = [save('crop-1', 's', { x: 0, y: 0, width: 1, height: 2 }, o)];
    const result = await buildCropPackage(makeRaw(), FILE, o, items, encodePng);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.crops[0].display.rect).toEqual(
      displayRectForCrop(items[0], RAW_SIZE, o),
    );
  });
});

describe('作废规则：任一失败则整包不得交付', () => {
  const items = () => [
    save('crop-1', 'a', { x: 0, y: 0, width: 1, height: 1 }, 1),
    save('crop-2', 'b', { x: 1, y: 0, width: 1, height: 1 }, 1),
  ];

  it('空裁片列表', async () => {
    const result = await buildCropPackage(makeRaw(), FILE, 1, [], encodePng);
    expect(result).toEqual({ ok: false, reason: 'empty' });
  });

  it('任一裁片编码失败 → encode-failed，无 ZIP', async () => {
    let calls = 0;
    const flaky = async (img: PixelImage) => {
      calls++;
      if (calls === 2) throw new Error('boom');
      return encodePng(img);
    };
    const result = await buildCropPackage(makeRaw(), FILE, 1, items(), flaky);
    expect(result).toEqual({ ok: false, reason: 'encode-failed' });
    expect(calls).toBe(2);
  });

  it('生成期间状态变更（isStale）→ stale，无 ZIP', async () => {
    let stale = false;
    const flipping = async (img: PixelImage) => {
      const bytes = await encodePng(img);
      stale = true; // 模拟首个编码完成后用户换了方向/裁片
      return bytes;
    };
    const result = await buildCropPackage(makeRaw(), FILE, 1, items(), flipping, () => stale);
    expect(result).toEqual({ ok: false, reason: 'stale' });
  });

  it('打包前状态已变更 → stale，且不进行任何编码', async () => {
    let calls = 0;
    const counting = async (img: PixelImage) => {
      calls++;
      return encodePng(img);
    };
    const result = await buildCropPackage(makeRaw(), FILE, 1, items(), counting, () => true);
    expect(result).toEqual({ ok: false, reason: 'stale' });
    expect(calls).toBe(0);
  });

  it('重复名称或越界矩形的快照 → invalid', async () => {
    const dup: CropItem[] = [
      { id: 'crop-1', name: 'a', rect: { x: 0, y: 0, width: 1, height: 1 } },
      { id: 'crop-2', name: 'A', rect: { x: 1, y: 0, width: 1, height: 1 } },
    ];
    expect(await buildCropPackage(makeRaw(), FILE, 1, dup, encodePng)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    const outside: CropItem[] = [
      { id: 'crop-1', name: 'a', rect: { x: 2, y: 1, width: 5, height: 5 } },
    ];
    expect(await buildCropPackage(makeRaw(), FILE, 1, outside, encodePng)).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('文件名派生：cropFileName', () => {
    expect(cropFileName('alpha')).toBe('alpha.png');
    expect(cropFileName('裁片-甲')).toBe('裁片-甲.png');
  });
});
