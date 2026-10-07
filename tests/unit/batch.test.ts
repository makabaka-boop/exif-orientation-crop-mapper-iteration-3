import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { Orientation, Rect, inverseMap, orientedSize } from '../../src/core/orientation';
import { exportCrop, isValidRect, mapRectToOriginal } from '../../src/core/crop';
import {
  MAX_CROPS,
  SavedCrop,
  addCrop,
  cropNameError,
  mapRectToDisplay,
  normalizeCropName,
  removeCrop,
} from '../../src/core/batch';
import {
  MANIFEST_FILE_NAME,
  buildManifest,
  cropFileName,
  sanitizeFileName,
} from '../../src/core/delivery';
import { buildZip, crc32, readZip } from '../../src/core/zip';
import {
  ALL_ORIENTATIONS,
  EXPECTED,
  RAW_H,
  RAW_ROWS,
  RAW_SIZE,
  RAW_W,
  makeRaw,
  toRows,
} from './matrix';

let seq = 0;
function crop(name: string, originalRect: Rect): SavedCrop {
  return { id: `crop-${++seq}`, name, originalRect };
}

describe('重投影：原图矩形 → 各方向显示矩形', () => {
  // 手工推导：与 orientation.test.ts 中「显示 → 原图」用例互为逆运算
  const CASES: Array<[Orientation, Rect, Rect]> = [
    [1, { x: 1, y: 0, width: 2, height: 2 }, { x: 1, y: 0, width: 2, height: 2 }],
    // 水平镜像：原图右列 ↔ 显示图左列
    [2, { x: 2, y: 0, width: 1, height: 2 }, { x: 0, y: 0, width: 1, height: 2 }],
    // 旋转 180°：原图右下角像素 ↔ 显示图左上角像素
    [3, { x: 2, y: 1, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }],
    // 垂直镜像：原图底行 ↔ 显示图顶行
    [4, { x: 0, y: 1, width: 3, height: 1 }, { x: 0, y: 0, width: 3, height: 1 }],
    // 转置：原图顶行（横条）↔ 显示图左列（竖条）
    [5, { x: 0, y: 0, width: 2, height: 1 }, { x: 0, y: 0, width: 1, height: 2 }],
    // 顺时针 90°：原图左列 ↔ 显示图顶行
    [6, { x: 0, y: 0, width: 1, height: 2 }, { x: 0, y: 0, width: 2, height: 1 }],
    // 副对角翻转：原图右列 ↔ 显示图顶行
    [7, { x: 2, y: 0, width: 1, height: 2 }, { x: 0, y: 0, width: 2, height: 1 }],
    // 逆时针 90°：原图右列 ↔ 显示图顶行
    [8, { x: 2, y: 0, width: 1, height: 2 }, { x: 0, y: 0, width: 2, height: 1 }],
  ];

  it.each(CASES)('方向 %i：原图矩形 %j → 显示矩形 %j', (o, original, display) => {
    expect(mapRectToDisplay(original, RAW_SIZE, o)).toEqual(display);
  });

  it.each(ALL_ORIENTATIONS)('方向 %i：显示 → 原图 → 显示 往返恒等', (o) => {
    const [w, h] = EXPECTED[o].size;
    const rects: Rect[] = [
      { x: 0, y: 0, width: w, height: h },
      { x: 0, y: 0, width: 1, height: 1 },
      { x: w - 1, y: h - 1, width: 1, height: 1 },
      { x: 0, y: h - 1, width: Math.min(2, w), height: 1 },
      { x: w - 1, y: 0, width: 1, height: Math.min(2, h) },
    ];
    for (const display of rects) {
      const roundTrip = mapRectToDisplay(mapRectToOriginal(display, RAW_SIZE, o), RAW_SIZE, o);
      expect(roundTrip).toEqual(display);
    }
  });

  it.each(ALL_ORIENTATIONS)('方向 %i：原图 → 显示 → 原图 往返恒等', (o) => {
    const rects: Rect[] = [
      { x: 0, y: 0, width: RAW_W, height: RAW_H },
      { x: 1, y: 0, width: 2, height: 1 },
      { x: 0, y: 1, width: 1, height: 1 },
      { x: 2, y: 0, width: 1, height: 2 },
    ];
    for (const original of rects) {
      const roundTrip = mapRectToOriginal(mapRectToDisplay(original, RAW_SIZE, o), RAW_SIZE, o);
      expect(roundTrip).toEqual(original);
    }
  });

  it('非法原图矩形拒绝投影', () => {
    expect(() => mapRectToDisplay({ x: 0, y: 0, width: 0, height: 1 }, RAW_SIZE, 1)).toThrow();
    expect(() => mapRectToDisplay({ x: 2, y: 1, width: 2, height: 2 }, RAW_SIZE, 1)).toThrow();
  });

  // 核心场景：裁片在方向 1 下保存（原图坐标固化），切换到镜像/旋转方向后
  // 重新投影出的区域必须与该方向期望矩阵的对应切片逐像素一致。
  it.each(ALL_ORIENTATIONS)(
    '方向 %i：方向 1 保存的裁片重投影后，导出像素等于期望矩阵切片',
    (o) => {
      const saved = crop('条带', { x: 1, y: 0, width: 2, height: 2 }); // 原图右两列 B,C,E,F
      const displayRect = mapRectToDisplay(saved.originalRect, RAW_SIZE, o);
      const display = orientedSize(RAW_SIZE, o);
      expect(isValidRect(displayRect, display)).toBe(true);
      const out = exportCrop(makeRaw(), displayRect, o);
      for (let j = 0; j < displayRect.height; j++) {
        for (let i = 0; i < displayRect.width; i++) {
          expect(toRows(out)[j][i]).toEqual(EXPECTED[o].rows[displayRect.y + j][displayRect.x + i]);
        }
      }
      // 区域内容仍是原图右两列的四个像素（集合不因方向改变）
      expect(toRows(out).flat().sort()).toEqual(
        [RAW_ROWS[0][1], RAW_ROWS[0][2], RAW_ROWS[1][1], RAW_ROWS[1][2]].sort(),
      );
    },
  );
});

describe('批次状态：命名与数量约束', () => {
  it('至多保存 8 个裁片，第 9 个抛错且不改变列表', () => {
    let list: SavedCrop[] = [];
    for (let i = 0; i < MAX_CROPS; i++) {
      list = addCrop(list, crop(`裁片${i + 1}`, { x: 0, y: 0, width: 1, height: 1 }), RAW_SIZE);
    }
    expect(list).toHaveLength(8);
    expect(() => addCrop(list, crop('超编', { x: 0, y: 0, width: 1, height: 1 }), RAW_SIZE)).toThrow(
      /上限/,
    );
    expect(list).toHaveLength(8); // 原列表未被修改
  });

  it('名称归一化：去首尾空白、压缩连续空白', () => {
    expect(normalizeCropName('  封面  竖条 ')).toBe('封面 竖条');
    expect(normalizeCropName('   ')).toBe('');
  });

  it('重名、空名、超长名均被拒绝', () => {
    const list = [crop('封面', { x: 0, y: 0, width: 1, height: 1 })];
    expect(cropNameError('', list)).toMatch(/不能为空/);
    expect(cropNameError('x'.repeat(41), list)).toMatch(/过长/);
    expect(cropNameError('封面', list)).toMatch(/已存在/);
    expect(cropNameError('封底', list)).toBeNull();
    expect(() => addCrop(list, crop('封面', { x: 1, y: 0, width: 1, height: 1 }), RAW_SIZE)).toThrow(
      /已存在/,
    );
  });

  it('id 重复与无效原图矩形均被拒绝', () => {
    const existing = crop('a', { x: 0, y: 0, width: 1, height: 1 });
    const list = addCrop([], existing, RAW_SIZE);
    expect(() => addCrop(list, { ...existing, name: 'b' }, RAW_SIZE)).toThrow(/id 重复/);
    expect(() => addCrop(list, crop('b', { x: 0, y: 0, width: 0, height: 1 }), RAW_SIZE)).toThrow(
      /无效/,
    );
    expect(() => addCrop(list, crop('b', { x: 2, y: 0, width: 2, height: 1 }), RAW_SIZE)).toThrow(
      /无效/,
    );
    expect(list).toHaveLength(1);
  });

  it('removeCrop 按身份移除且不改原列表', () => {
    const a = crop('a', { x: 0, y: 0, width: 1, height: 1 });
    const b = crop('b', { x: 1, y: 0, width: 1, height: 1 });
    const list = addCrop(addCrop([], a, RAW_SIZE), b, RAW_SIZE);
    const after = removeCrop(list, a.id);
    expect(after.map((c) => c.id)).toEqual([b.id]);
    expect(list).toHaveLength(2);
    expect(removeCrop(list, '不存在')).toHaveLength(2);
  });
});

describe('交付清单：逐项绑定原图、显示矩形与文件名', () => {
  const crops: SavedCrop[] = [
    { id: 'crop-1', name: '左条', originalRect: { x: 0, y: 0, width: 1, height: 2 } },
    { id: 'crop-2', name: '右角', originalRect: { x: 2, y: 1, width: 1, height: 1 } },
  ];
  const snapshot = {
    image: { name: 'photo.png', type: 'image/png', width: RAW_W, height: RAW_H },
    orientation: 5 as Orientation, // 镜像 + 旋转
    crops,
  };

  it('方向 5：清单条目与核心映射逐字段一致', () => {
    const manifest = buildManifest(snapshot);
    expect(manifest.version).toBe(1);
    expect(manifest.image).toEqual(snapshot.image);
    expect(manifest.orientation).toBe(5);
    expect(manifest.display).toEqual({ width: 2, height: 3 });
    expect(manifest.crops).toHaveLength(2);

    for (const [index, entry] of manifest.crops.entries()) {
      const saved = crops[index];
      // 同一裁片身份贯穿
      expect(entry.id).toBe(saved.id);
      expect(entry.name).toBe(saved.name);
      expect(entry.file).toBe(cropFileName(index, saved.name));
      // 原图矩形即保存时固化的区域
      expect(entry.original.rect).toEqual(saved.originalRect);
      // 显示矩形与页面 overlay 用同一函数投影
      expect(entry.display.rect).toEqual(
        mapRectToDisplay(saved.originalRect, RAW_SIZE, snapshot.orientation),
      );
      expect(entry.display.width).toBe(2);
      expect(entry.display.height).toBe(3);
      // 四角与逆映射一致，且包围盒回到保存的原图矩形
      expect(entry.original.corners).toHaveLength(4);
      for (const c of entry.original.corners) {
        expect({ x: c.x, y: c.y }).toEqual(
          inverseMap(c.u, c.v, RAW_SIZE, snapshot.orientation),
        );
      }
      expect(mapRectToOriginal(entry.display.rect, RAW_SIZE, snapshot.orientation)).toEqual(
        saved.originalRect,
      );
    }
    expect(manifest.coordinateSystem).toContain('original-image');
  });

  it.each(ALL_ORIENTATIONS)('方向 %i：清单显示矩形重投影后仍可逆推保存的原图矩形', (o) => {
    const manifest = buildManifest({ ...snapshot, orientation: o });
    for (const [index, entry] of manifest.crops.entries()) {
      expect(mapRectToOriginal(entry.display.rect, RAW_SIZE, o)).toEqual(
        crops[index].originalRect,
      );
    }
  });

  it('清单可 JSON 序列化往返（包内 manifest.json 的形态）', () => {
    const manifest = buildManifest(snapshot);
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });
});

describe('包内文件名', () => {
  it('净化非法字符，空名称回退', () => {
    expect(sanitizeFileName('封面/竖条')).toBe('封面_竖条');
    expect(sanitizeFileName('a\\b:c*d?e"f<g>h|i')).toBe('a_b_c_d_e_f_g_h_i');
    expect(sanitizeFileName('   ')).toBe('crop');
  });

  it('序号前缀保证净化后重名也不冲突', () => {
    expect(cropFileName(0, 'a/b')).toBe('01-a_b.png');
    expect(cropFileName(1, 'a:b')).toBe('02-a_b.png');
    expect(cropFileName(7, 'x')).toBe('08-x.png');
  });
});

describe('ZIP 打包', () => {
  it('crc32 标准测试向量', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('buildZip/readZip 往返：UTF-8 名称与字节内容一致', () => {
    const entries = [
      { name: '01-封面.png', data: new Uint8Array([1, 2, 3, 250]) },
      { name: MANIFEST_FILE_NAME, data: new TextEncoder().encode('{"a":1}') },
    ];
    const zip = buildZip(entries);
    const back = readZip(zip);
    expect(back.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    back.forEach((e, i) => expect(Array.from(e.data)).toEqual(Array.from(entries[i].data)));
  });

  it('空包合法，损坏与 CRC 不匹配被拒绝', () => {
    expect(readZip(buildZip([]))).toEqual([]);
    const zip = buildZip([{ name: 'a.bin', data: new Uint8Array([7, 7, 7]) }]);
    const tampered = zip.slice();
    tampered[35] ^= 0xff; // 翻动数据区一个字节
    expect(() => readZip(tampered)).toThrow(/CRC/);
    expect(() => readZip(new Uint8Array([1, 2, 3]))).toThrow(/not a ZIP/);
  });
});

describe('整包集成：非对称矩阵核对镜像/旋转后的区域与包内清单', () => {
  function encodePngBytes(img: { width: number; height: number; data: Uint8ClampedArray }) {
    const png = new PNG({ width: img.width, height: img.height });
    png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    return PNG.sync.write(png);
  }

  it.each([2, 5, 6] as Orientation[])('方向 %i：包内 PNG 与清单逐项互相印证', (o) => {
    // 与 App 同一流程：快照 → 清单 → 逐裁片 exportCrop → 编码 → 打包
    const crops: SavedCrop[] = [
      { id: 'crop-1', name: '整幅', originalRect: { x: 0, y: 0, width: RAW_W, height: RAW_H } },
      { id: 'crop-2', name: '右列', originalRect: { x: 2, y: 0, width: 1, height: 2 } },
      { id: 'crop-3', name: '角点', originalRect: { x: 0, y: 1, width: 1, height: 1 } },
    ];
    const snapshot = {
      image: { name: 'matrix.png', type: 'image/png', width: RAW_W, height: RAW_H },
      orientation: o,
      crops,
    };
    const manifest = buildManifest(snapshot);
    const raw = makeRaw();
    const entries = manifest.crops.map((entry) => ({
      name: entry.file,
      data: new Uint8Array(encodePngBytes(exportCrop(raw, entry.display.rect, o))),
    }));
    entries.push({
      name: MANIFEST_FILE_NAME,
      data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
    });

    // 复核端：解包 → 清单与 PNG 逐项核对
    const unpacked = readZip(buildZip(entries));
    expect(unpacked.map((e) => e.name)).toEqual([
      '01-整幅.png',
      '02-右列.png',
      '03-角点.png',
      MANIFEST_FILE_NAME,
    ]);
    const parsed = JSON.parse(new TextDecoder().decode(unpacked[3].data));
    expect(parsed).toEqual(manifest);

    for (const [index, entry] of parsed.crops.entries()) {
      // 清单条目 ↔ 包内文件名一一对应
      const file = unpacked[index];
      expect(entry.file).toBe(file.name);
      // PNG 尺寸 = 清单显示矩形
      const png = PNG.sync.read(Buffer.from(file.data));
      expect(png.width).toBe(entry.display.rect.width);
      expect(png.height).toBe(entry.display.rect.height);
      // PNG 内容 = 期望矩阵在显示矩形处的切片（镜像/旋转后的区域正确）
      const expected = exportCrop(makeRaw(), entry.display.rect, o);
      expect(Array.from(png.data)).toEqual(Array.from(expected.data));
      // 清单原图矩形 ↔ 保存的裁片身份
      expect(entry.id).toBe(crops[index].id);
      expect(entry.original.rect).toEqual(crops[index].originalRect);
    }

    // 整幅裁片的内容就是该方向的完整期望矩阵
    const whole = PNG.sync.read(Buffer.from(unpacked[0].data));
    const wholeRows: unknown[][] = [];
    for (let y = 0; y < whole.height; y++) {
      const row: unknown[] = [];
      for (let x = 0; x < whole.width; x++) {
        row.push(Array.from(whole.data.slice((y * whole.width + x) * 4, (y * whole.width + x) * 4 + 4)));
      }
      wholeRows.push(row);
    }
    expect(wholeRows).toEqual(EXPECTED[o].rows.map((r) => r.map((c) => Array.from(c))));
  });
});
