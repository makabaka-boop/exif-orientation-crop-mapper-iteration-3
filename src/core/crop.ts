/**
 * 裁切矩形：校验、逆变换到原始坐标、无缩放导出、JSON 元数据。
 *
 * 裁切矩形定义在「显示后的正向图像」上，边落在整像素边界，
 * 语义为半开区间 [x, x+width) × [y, y+height)。
 */
import {
  Orientation,
  PixelImage,
  Rect,
  Size,
  forwardMap,
  inverseMap,
  orientedSize,
} from './orientation';

/** 由两个整像素边界点构造半开矩形（自动取 min/max）。 */
export function rectFromBounds(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): Rect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

/**
 * 矩形是否合法：整数边界、面积为正、完整落在显示图范围内。
 * 非法矩形不应产生任何下载，但当前图片保持显示。
 */
export function isValidRect(rect: Rect, display: Size): boolean {
  const { x, y, width, height } = rect;
  if (![x, y, width, height].every(Number.isFinite)) return false;
  if (![x, y, width, height].every(Number.isInteger)) return false;
  if (width <= 0 || height <= 0) return false;
  if (x < 0 || y < 0) return false;
  if (x + width > display.width || y + height > display.height) return false;
  return true;
}

/** 显示矩形四角（像素单元）逆变换到原始坐标后的对应点。 */
export interface MappedCorner {
  /** 显示坐标（像素单元左上角序：左上、右上、左下、右下）。 */
  u: number;
  v: number;
  /** 对应的原始图像像素坐标。 */
  x: number;
  y: number;
}

/**
 * 将半开显示矩形的四角逆变换到原始图像。
 * 取的是矩形覆盖的像素单元的四个角：(x,y)、(x+w-1,y)、(x,y+h-1)、(x+w-1,y+h-1)。
 */
export function mapCornersToOriginal(
  rect: Rect,
  raw: Size,
  orientation: Orientation,
): MappedCorner[] {
  const display = orientedSize(raw, orientation);
  if (!isValidRect(rect, display)) {
    throw new Error(`invalid crop rect for ${display.width}x${display.height} display`);
  }
  const cells = [
    { u: rect.x, v: rect.y },
    { u: rect.x + rect.width - 1, v: rect.y },
    { u: rect.x, v: rect.y + rect.height - 1 },
    { u: rect.x + rect.width - 1, v: rect.y + rect.height - 1 },
  ];
  return cells.map(({ u, v }) => ({ u, v, ...inverseMap(u, v, raw, orientation) }));
}

/**
 * 显示矩形 → 原始图像中的半开矩形（四角的轴对齐包围盒）。
 * 镜像方向下，显示图左边的条带会映射到原图右侧——这正是必须
 * 逐角逆变换而不能直接平移坐标的原因。
 */
export function mapRectToOriginal(
  rect: Rect,
  raw: Size,
  orientation: Orientation,
): Rect {
  const corners = mapCornersToOriginal(rect, raw, orientation);
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return {
    x: x0,
    y: y0,
    width: Math.max(...xs) - x0 + 1,
    height: Math.max(...ys) - y0 + 1,
  };
}

/**
 * 原图矩形的四角（像素单元）正变换到显示坐标后的对应点。
 * 与 mapCornersToOriginal 互为反向：这里取原图矩形覆盖的像素单元四角，
 * 经 forwardMap 得到显示坐标。
 */
export function mapCornersToDisplay(
  rect: Rect,
  raw: Size,
  orientation: Orientation,
): MappedCorner[] {
  if (!isValidRect(rect, raw)) {
    throw new Error(`invalid original rect for ${raw.width}x${raw.height} image`);
  }
  const cells = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width - 1, y: rect.y },
    { x: rect.x, y: rect.y + rect.height - 1 },
    { x: rect.x + rect.width - 1, y: rect.y + rect.height - 1 },
  ];
  return cells.map(({ x, y }) => { const { u, v } = forwardMap(x, y, raw, orientation); return { u, v, x, y }; });
}

/**
 * 原图矩形 → 指定方向下显示图中的半开矩形（四角的轴对齐包围盒）。
 * 已保存裁片以原图坐标记录，切换方向后必须经此重投影得到显示矩形，
 * 而不能把旧方向下的显示坐标直接套用到新方向。
 */
export function mapRectToDisplay(
  rect: Rect,
  raw: Size,
  orientation: Orientation,
): Rect {
  const corners = mapCornersToDisplay(rect, raw, orientation);
  const us = corners.map((c) => c.u);
  const vs = corners.map((c) => c.v);
  const u0 = Math.min(...us);
  const v0 = Math.min(...vs);
  return {
    x: u0,
    y: v0,
    width: Math.max(...us) - u0 + 1,
    height: Math.max(...vs) - v0 + 1,
  };
}

/**
 * 从原始像素无缩放导出正向裁切图。
 * 输出像素 (i, j) 取自原始图像 inverseMap(rect.x + i, rect.y + j)，
 * 与预览中同一区域逐像素一致。
 */
export function exportCrop(
  raw: PixelImage,
  rect: Rect,
  orientation: Orientation,
): PixelImage {
  const display = orientedSize(raw, orientation);
  if (!isValidRect(rect, display)) {
    throw new Error(`invalid crop rect for ${display.width}x${display.height} display`);
  }
  const out: PixelImage = {
    width: rect.width,
    height: rect.height,
    data: new Uint8ClampedArray(rect.width * rect.height * 4),
  };
  for (let j = 0; j < rect.height; j++) {
    for (let i = 0; i < rect.width; i++) {
      const { x, y } = inverseMap(rect.x + i, rect.y + j, raw, orientation);
      const si = (y * raw.width + x) * 4;
      const di = (j * out.width + i) * 4;
      out.data[di] = raw.data[si];
      out.data[di + 1] = raw.data[si + 1];
      out.data[di + 2] = raw.data[si + 2];
      out.data[di + 3] = raw.data[si + 3];
    }
  }
  return out;
}

/** 导出 JSON 元数据：与 PNG 导出使用同一映射，包含原图坐标。 */
export interface CropMetadata {
  image: {
    name: string;
    type: string;
    width: number;
    height: number;
  };
  orientation: Orientation;
  display: {
    width: number;
    height: number;
    rect: Rect;
  };
  original: {
    rect: Rect;
    corners: MappedCorner[];
  };
  coordinateSystem: string;
}

export function buildCropMetadata(
  raw: Size,
  file: { name: string; type: string },
  orientation: Orientation,
  rect: Rect,
): CropMetadata {
  const display = orientedSize(raw, orientation);
  return {
    image: { name: file.name, type: file.type, width: raw.width, height: raw.height },
    orientation,
    display: { width: display.width, height: display.height, rect: { ...rect } },
    original: {
      rect: mapRectToOriginal(rect, raw, orientation),
      corners: mapCornersToOriginal(rect, raw, orientation),
    },
    coordinateSystem:
      'original-image pixel coordinates, origin top-left, half-open [x, x+width) x [y, y+height)',
  };
}
