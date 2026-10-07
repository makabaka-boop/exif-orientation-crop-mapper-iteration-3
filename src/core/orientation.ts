/**
 * EXIF 方向（1～8）的像素坐标映射。
 *
 * 原始（存储）像素坐标：x ∈ [0, W)，y ∈ [0, H)，原点在左上。
 * 显示（正向）像素坐标：u ∈ [0, W')，v ∈ [0, H')，原点在左上。
 *
 * 方向 2/4/5/7 含镜像，因此显示坐标系中的矩形不能简单地
 * 平移回原始坐标——必须逐角逆变换后再取包围盒。
 */

export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const ORIENTATIONS: readonly Orientation[] = [1, 2, 3, 4, 5, 6, 7, 8];

export interface Size {
  width: number;
  height: number;
}

/** 一幅 8-bit RGBA 图像（与 ImageData 结构兼容的最小接口）。 */
export interface PixelImage extends Size {
  data: Uint8ClampedArray;
}

/** 半开矩形：[x, x+width) × [y, y+height)，坐标为整像素边界。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 方向是否交换宽高（5～8 为 90° 系旋转）。 */
export function swapsAxes(orientation: Orientation): boolean {
  return orientation >= 5;
}

/** 应用方向后显示图的尺寸。 */
export function orientedSize(raw: Size, orientation: Orientation): Size {
  return swapsAxes(orientation)
    ? { width: raw.height, height: raw.width }
    : { width: raw.width, height: raw.height };
}

/** 正向映射：原始像素 (x, y) → 显示像素 (u, v)。 */
export function forwardMap(
  x: number,
  y: number,
  raw: Size,
  orientation: Orientation,
): { u: number; v: number } {
  const { width: w, height: h } = raw;
  switch (orientation) {
    case 1: // 恒等
      return { u: x, v: y };
    case 2: // 水平镜像
      return { u: w - 1 - x, v: y };
    case 3: // 旋转 180°
      return { u: w - 1 - x, v: h - 1 - y };
    case 4: // 垂直镜像
      return { u: x, v: h - 1 - y };
    case 5: // 主对角转置（镜像 + 旋转 270°）
      return { u: y, v: x };
    case 6: // 顺时针旋转 90°
      return { u: h - 1 - y, v: x };
    case 7: // 副对角转置（镜像 + 旋转 90°）
      return { u: h - 1 - y, v: w - 1 - x };
    case 8: // 逆时针旋转 90°
      return { u: y, v: w - 1 - x };
  }
}

/** 逆映射：显示像素 (u, v) → 原始像素 (x, y)。 */
export function inverseMap(
  u: number,
  v: number,
  raw: Size,
  orientation: Orientation,
): { x: number; y: number } {
  const { width: w, height: h } = raw;
  switch (orientation) {
    case 1:
      return { x: u, y: v };
    case 2:
      return { x: w - 1 - u, y: v };
    case 3:
      return { x: w - 1 - u, y: h - 1 - v };
    case 4:
      return { x: u, y: h - 1 - v };
    case 5:
      return { x: v, y: u };
    case 6:
      return { x: v, y: h - 1 - u };
    case 7:
      return { x: w - 1 - v, y: h - 1 - u };
    case 8:
      return { x: w - 1 - v, y: u };
  }
}

/** 由原始像素构建正向（显示方向）图像，逐像素精确拷贝，无缩放无插值。 */
export function buildOriented(raw: PixelImage, orientation: Orientation): PixelImage {
  const out = orientedSize(raw, orientation);
  const data = new Uint8ClampedArray(out.width * out.height * 4);
  for (let y = 0; y < raw.height; y++) {
    for (let x = 0; x < raw.width; x++) {
      const { u, v } = forwardMap(x, y, raw, orientation);
      const si = (y * raw.width + x) * 4;
      const di = (v * out.width + u) * 4;
      data[di] = raw.data[si];
      data[di + 1] = raw.data[si + 1];
      data[di + 2] = raw.data[si + 2];
      data[di + 3] = raw.data[si + 3];
    }
  }
  return { width: out.width, height: out.height, data };
}

/** 读取单个像素（越界抛错，便于测试发现映射错误）。 */
export function pixelAt(img: PixelImage, x: number, y: number): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) {
    throw new RangeError(`pixel out of bounds: (${x}, ${y}) in ${img.width}x${img.height}`);
  }
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}
