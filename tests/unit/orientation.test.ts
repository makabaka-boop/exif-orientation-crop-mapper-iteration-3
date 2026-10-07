import { describe, expect, it } from 'vitest';
import {
  Orientation,
  PixelImage,
  Rect,
  buildOriented,
  forwardMap,
  inverseMap,
  orientedSize,
  pixelAt,
} from '../../src/core/orientation';
import {
  buildCropMetadata,
  exportCrop,
  isValidRect,
  mapCornersToOriginal,
  mapRectToOriginal,
  rectFromBounds,
} from '../../src/core/crop';

/**
 * 非对称 2×3 彩色像素矩阵（宽 3，高 2），六种颜色互不相同，
 * 任何旋转/镜像都会产生可区分的不同排布。
 *
 *   A B C      A=红  B=绿  C=蓝
 *   D E F      D=黄  E=品红 F=青
 */
const A = [255, 0, 0, 255] as const;
const B = [0, 255, 0, 255] as const;
const C = [0, 0, 255, 255] as const;
const D = [255, 255, 0, 255] as const;
const E = [255, 0, 255, 255] as const;
const F = [0, 255, 255, 255] as const;

type Color = readonly [number, number, number, number];

const RAW_W = 3;
const RAW_H = 2;
const RAW_ROWS: Color[][] = [
  [A, B, C],
  [D, E, F],
];

function makeRaw(): PixelImage {
  const data = new Uint8ClampedArray(RAW_W * RAW_H * 4);
  RAW_ROWS.forEach((row, y) =>
    row.forEach((c, x) => data.set(c, (y * RAW_W + x) * 4)),
  );
  return { width: RAW_W, height: RAW_H, data };
}

/** 把图像读回颜色矩阵，便于整体断言。 */
function toRows(img: PixelImage): Color[][] {
  const rows: Color[][] = [];
  for (let y = 0; y < img.height; y++) {
    const row: Color[] = [];
    for (let x = 0; x < img.width; x++) row.push(pixelAt(img, x, y));
    rows.push(row);
  }
  return rows;
}

/** 手工推导的八种方向期望矩阵（含镜像方向 2/4/5/7）。 */
const EXPECTED: Record<Orientation, { size: [number, number]; rows: Color[][] }> = {
  1: { size: [3, 2], rows: [[A, B, C], [D, E, F]] },
  2: { size: [3, 2], rows: [[C, B, A], [F, E, D]] },
  3: { size: [3, 2], rows: [[F, E, D], [C, B, A]] },
  4: { size: [3, 2], rows: [[D, E, F], [A, B, C]] },
  5: { size: [2, 3], rows: [[A, D], [B, E], [C, F]] },
  6: { size: [2, 3], rows: [[D, A], [E, B], [F, C]] },
  7: { size: [2, 3], rows: [[F, C], [E, B], [D, A]] },
  8: { size: [2, 3], rows: [[C, F], [B, E], [A, D]] },
};

const ALL: Orientation[] = [1, 2, 3, 4, 5, 6, 7, 8];
const rawSize = { width: RAW_W, height: RAW_H };

describe('八种 EXIF 方向的正向变换', () => {
  it.each(ALL)('方向 %i：显示尺寸正确', (o) => {
    const [w, h] = EXPECTED[o].size;
    expect(orientedSize(rawSize, o)).toEqual({ width: w, height: h });
  });

  it.each(ALL)('方向 %i：buildOriented 逐像素等于期望矩阵', (o) => {
    expect(toRows(buildOriented(makeRaw(), o))).toEqual(EXPECTED[o].rows);
  });

  it.each(ALL)('方向 %i：forwardMap 把每个原图像素送到期望位置', (o) => {
    const seen = new Set<string>();
    for (let y = 0; y < RAW_H; y++) {
      for (let x = 0; x < RAW_W; x++) {
        const { u, v } = forwardMap(x, y, rawSize, o);
        expect(EXPECTED[o].rows[v][u]).toEqual(RAW_ROWS[y][x]);
        seen.add(`${u},${v}`);
      }
    }
    // 双射：显示图每个像素恰好被覆盖一次
    const [w, h] = EXPECTED[o].size;
    expect(seen.size).toBe(w * h);
  });
});

describe('逆变换（显示坐标 → 原图坐标）', () => {
  it.each(ALL)('方向 %i：inverseMap 逐像素还原期望矩阵', (o) => {
    const [w, h] = EXPECTED[o].size;
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const { x, y } = inverseMap(u, v, rawSize, o);
        expect(RAW_ROWS[y][x]).toEqual(EXPECTED[o].rows[v][u]);
      }
    }
  });

  it.each(ALL)('方向 %i：forward/inverse 互为逆映射（双向往返）', (o) => {
    const [w, h] = EXPECTED[o].size;
    for (let y = 0; y < RAW_H; y++) {
      for (let x = 0; x < RAW_W; x++) {
        const { u, v } = forwardMap(x, y, rawSize, o);
        expect(inverseMap(u, v, rawSize, o)).toEqual({ x, y });
      }
    }
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        const { x, y } = inverseMap(u, v, rawSize, o);
        expect(forwardMap(x, y, rawSize, o)).toEqual({ u, v });
      }
    }
  });
});

describe('裁切矩形四角逆变换到原图', () => {
  it.each(ALL)('方向 %i：整幅显示矩形映射回整幅原图', (o) => {
    const [w, h] = EXPECTED[o].size;
    const rect: Rect = { x: 0, y: 0, width: w, height: h };
    expect(mapRectToOriginal(rect, rawSize, o)).toEqual({
      x: 0,
      y: 0,
      width: RAW_W,
      height: RAW_H,
    });
  });

  // 手工推导的镜像/旋转用例：显示图边缘条带映射回原图的正确一侧
  const CASES: Array<[Orientation, Rect, Rect]> = [
    [1, { x: 1, y: 0, width: 2, height: 2 }, { x: 1, y: 0, width: 2, height: 2 }],
    // 水平镜像：显示图左列 ↔ 原图右列
    [2, { x: 0, y: 0, width: 1, height: 2 }, { x: 2, y: 0, width: 1, height: 2 }],
    // 旋转 180°：显示图左上角像素 ↔ 原图右下角像素
    [3, { x: 0, y: 0, width: 1, height: 1 }, { x: 2, y: 1, width: 1, height: 1 }],
    // 垂直镜像：显示图顶行 ↔ 原图底行
    [4, { x: 0, y: 0, width: 3, height: 1 }, { x: 0, y: 1, width: 3, height: 1 }],
    // 转置：显示图左列（竖条）↔ 原图顶行（横条）
    [5, { x: 0, y: 0, width: 1, height: 2 }, { x: 0, y: 0, width: 2, height: 1 }],
    // 顺时针 90°：显示图顶行 ↔ 原图左列
    [6, { x: 0, y: 0, width: 2, height: 1 }, { x: 0, y: 0, width: 1, height: 2 }],
    // 副对角翻转：显示图顶行 ↔ 原图右列
    [7, { x: 0, y: 0, width: 2, height: 1 }, { x: 2, y: 0, width: 1, height: 2 }],
    // 逆时针 90°：显示图顶行 ↔ 原图右列
    [8, { x: 0, y: 0, width: 2, height: 1 }, { x: 2, y: 0, width: 1, height: 2 }],
  ];

  it.each(CASES)('方向 %i：显示矩形 %j → 原图矩形 %j', (o, display, original) => {
    expect(mapRectToOriginal(display, rawSize, o)).toEqual(original);
  });

  it.each(ALL)('方向 %i：四角映射与 inverseMap 一致且包围盒等于矩形映射', (o) => {
    const [w, h] = EXPECTED[o].size;
    const rect: Rect = { x: 0, y: 0, width: w - 1 > 0 ? w - 1 : 1, height: h };
    const corners = mapCornersToOriginal(rect, rawSize, o);
    expect(corners).toHaveLength(4);
    for (const c of corners) {
      expect({ x: c.x, y: c.y }).toEqual(inverseMap(c.u, c.v, rawSize, o));
    }
    const mapped = mapRectToOriginal(rect, rawSize, o);
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    expect(mapped).toEqual({
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs) + 1,
      height: Math.max(...ys) - Math.min(...ys) + 1,
    });
  });
});

describe('无缩放导出正向裁切图', () => {
  it.each(ALL)('方向 %i：整幅导出等于期望矩阵', (o) => {
    const [w, h] = EXPECTED[o].size;
    const out = exportCrop(makeRaw(), { x: 0, y: 0, width: w, height: h }, o);
    expect(toRows(out)).toEqual(EXPECTED[o].rows);
  });

  it.each(ALL)('方向 %i：子矩形导出等于期望矩阵的对应切片', (o) => {
    const [w, h] = EXPECTED[o].size;
    const rect: Rect = { x: w - 1, y: 0, width: 1, height: h }; // 显示图最右列
    const out = exportCrop(makeRaw(), rect, o);
    expect(out.width).toBe(1);
    expect(out.height).toBe(h);
    for (let j = 0; j < h; j++) {
      expect(pixelAt(out, 0, j)).toEqual(EXPECTED[o].rows[j][w - 1]);
    }
  });

  it.each(ALL)('方向 %i：导出与预览（buildOriented）逐像素一致', (o) => {
    const [w, h] = EXPECTED[o].size;
    const oriented = buildOriented(makeRaw(), o);
    const rect: Rect = { x: 0, y: 1 % h, width: w, height: h - (1 % h) };
    const out = exportCrop(makeRaw(), rect, o);
    for (let j = 0; j < rect.height; j++) {
      for (let i = 0; i < rect.width; i++) {
        expect(pixelAt(out, i, j)).toEqual(pixelAt(oriented, rect.x + i, rect.y + j));
      }
    }
  });
});

describe('边界与非法矩形', () => {
  it.each(ALL)('方向 %i：四个显示角的 1×1 矩形命中正确的原图像素', (o) => {
    const [w, h] = EXPECTED[o].size;
    const corners: Array<[number, number, Color]> = [
      [0, 0, EXPECTED[o].rows[0][0]],
      [w - 1, 0, EXPECTED[o].rows[0][w - 1]],
      [0, h - 1, EXPECTED[o].rows[h - 1][0]],
      [w - 1, h - 1, EXPECTED[o].rows[h - 1][w - 1]],
    ];
    for (const [u, v, color] of corners) {
      const out = exportCrop(makeRaw(), { x: u, y: v, width: 1, height: 1 }, o);
      expect(pixelAt(out, 0, 0)).toEqual(color);
      const mapped = mapRectToOriginal({ x: u, y: v, width: 1, height: 1 }, rawSize, o);
      expect(RAW_ROWS[mapped.y][mapped.x]).toEqual(color);
      expect(mapped.width).toBe(1);
      expect(mapped.height).toBe(1);
    }
  });

  it('合法矩形：整幅、单像素、贴边', () => {
    const size = { width: 3, height: 2 };
    expect(isValidRect({ x: 0, y: 0, width: 3, height: 2 }, size)).toBe(true);
    expect(isValidRect({ x: 2, y: 1, width: 1, height: 1 }, size)).toBe(true);
    expect(isValidRect({ x: 0, y: 0, width: 1, height: 1 }, size)).toBe(true);
  });

  it('非法矩形：零面积、负坐标、越界、非整数、非有限值', () => {
    const size = { width: 3, height: 2 };
    expect(isValidRect({ x: 1, y: 1, width: 0, height: 1 }, size)).toBe(false);
    expect(isValidRect({ x: 1, y: 1, width: 1, height: 0 }, size)).toBe(false);
    expect(isValidRect({ x: -1, y: 0, width: 2, height: 1 }, size)).toBe(false);
    expect(isValidRect({ x: 0, y: 0, width: 4, height: 1 }, size)).toBe(false);
    expect(isValidRect({ x: 0, y: 1, width: 1, height: 2 }, size)).toBe(false);
    expect(isValidRect({ x: 0.5, y: 0, width: 1, height: 1 }, size)).toBe(false);
    expect(isValidRect({ x: 0, y: 0, width: Number.NaN, height: 1 }, size)).toBe(false);
    expect(isValidRect({ x: 0, y: 0, width: 1, height: Number.POSITIVE_INFINITY }, size)).toBe(
      false,
    );
  });

  it.each(ALL)('方向 %i：非法矩形拒绝映射与导出', (o) => {
    const [w, h] = EXPECTED[o].size;
    const empty: Rect = { x: 1, y: 1, width: 0, height: 0 };
    const outside: Rect = { x: w - 1, y: h - 1, width: 2, height: 2 };
    for (const bad of [empty, outside]) {
      expect(() => mapRectToOriginal(bad, rawSize, o)).toThrow();
      expect(() => mapCornersToOriginal(bad, rawSize, o)).toThrow();
      expect(() => exportCrop(makeRaw(), bad, o)).toThrow();
    }
  });

  it('rectFromBounds：任意方向拖动都归一化为半开矩形', () => {
    expect(rectFromBounds(5, 4, 2, 1)).toEqual({ x: 2, y: 1, width: 3, height: 3 });
    expect(rectFromBounds(2, 1, 5, 4)).toEqual({ x: 2, y: 1, width: 3, height: 3 });
    expect(rectFromBounds(3, 3, 3, 3)).toEqual({ x: 3, y: 3, width: 0, height: 0 });
  });
});

describe('JSON 元数据（与导出同一映射）', () => {
  it('方向 5：包含原图坐标、四角与显示矩形', () => {
    const rect: Rect = { x: 0, y: 0, width: 1, height: 2 };
    const meta = buildCropMetadata(
      rawSize,
      { name: 'photo.png', type: 'image/png' },
      5,
      rect,
    );
    expect(meta.orientation).toBe(5);
    expect(meta.image).toMatchObject({ name: 'photo.png', width: 3, height: 2 });
    expect(meta.display).toEqual({ width: 2, height: 3, rect });
    expect(meta.original.rect).toEqual({ x: 0, y: 0, width: 2, height: 1 });
    expect(meta.original.corners).toHaveLength(4);
    expect(meta.coordinateSystem).toContain('original-image');
  });

  it.each(ALL)('方向 %i：JSON 原图矩形与 mapRectToOriginal 一致', (o) => {
    const [w, h] = EXPECTED[o].size;
    const rect: Rect = { x: 0, y: 0, width: w, height: h };
    const meta = buildCropMetadata(rawSize, { name: 'a.jpg', type: 'image/jpeg' }, o, rect);
    expect(meta.original.rect).toEqual(mapRectToOriginal(rect, rawSize, o));
  });
});
