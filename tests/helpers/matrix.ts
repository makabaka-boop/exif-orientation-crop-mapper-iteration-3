/**
 * 测试共享的非对称小像素矩阵：3×2，六种颜色互不相同，
 * 任何旋转/镜像都会产生可区分的排布。
 *
 *   A B C      A=红  B=绿  C=蓝
 *   D E F      D=黄  E=品红 F=青
 */
import { Orientation, PixelImage, pixelAt } from '../../src/core/orientation';

export const A = [255, 0, 0, 255] as const;
export const B = [0, 255, 0, 255] as const;
export const C = [0, 0, 255, 255] as const;
export const D = [255, 255, 0, 255] as const;
export const E = [255, 0, 255, 255] as const;
export const F = [0, 255, 255, 255] as const;

export type Color = readonly [number, number, number, number];

export const RAW_W = 3;
export const RAW_H = 2;
export const RAW_ROWS: Color[][] = [
  [A, B, C],
  [D, E, F],
];

export function makeRaw(): PixelImage {
  const data = new Uint8ClampedArray(RAW_W * RAW_H * 4);
  RAW_ROWS.forEach((row, y) => row.forEach((c, x) => data.set(c, (y * RAW_W + x) * 4)));
  return { width: RAW_W, height: RAW_H, data };
}

/** 把图像读回颜色矩阵，便于整体断言。 */
export function toRows(img: PixelImage): Color[][] {
  const rows: Color[][] = [];
  for (let y = 0; y < img.height; y++) {
    const row: Color[] = [];
    for (let x = 0; x < img.width; x++) row.push(pixelAt(img, x, y));
    rows.push(row);
  }
  return rows;
}

/** 手工推导的八种方向期望矩阵（含镜像方向 2/4/5/7）。 */
export const EXPECTED: Record<Orientation, { size: [number, number]; rows: Color[][] }> = {
  1: { size: [3, 2], rows: [[A, B, C], [D, E, F]] },
  2: { size: [3, 2], rows: [[C, B, A], [F, E, D]] },
  3: { size: [3, 2], rows: [[F, E, D], [C, B, A]] },
  4: { size: [3, 2], rows: [[D, E, F], [A, B, C]] },
  5: { size: [2, 3], rows: [[A, D], [B, E], [C, F]] },
  6: { size: [2, 3], rows: [[D, A], [E, B], [F, C]] },
  7: { size: [2, 3], rows: [[F, C], [E, B], [D, A]] },
  8: { size: [2, 3], rows: [[C, F], [B, E], [A, D]] },
};

export const ALL_ORIENTATIONS: Orientation[] = [1, 2, 3, 4, 5, 6, 7, 8];
export const RAW_SIZE = { width: RAW_W, height: RAW_H };
