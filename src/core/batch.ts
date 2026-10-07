/**
 * 多裁片工作区：裁片身份、批次状态（至多 8 个唯一命名裁片）、
 * 以及原图坐标 → 显示坐标的重投影。
 *
 * 裁片在保存时即固化为「原始（存储方向）像素坐标」的半开矩形，
 * 与当前 EXIF 方向无关；切换方向后用 mapRectToDisplay 重新投影，
 * 绝不把旧的显示坐标直接套到新方向上。
 *
 * 核心映射、批次状态、打包与页面预览共享同一个 SavedCrop 身份：
 * 列表、画布 overlay、清单条目与 ZIP 内文件名都由它派生。
 */
import { Orientation, Rect, Size, forwardMap } from './orientation';
import { isValidRect } from './crop';

/** 一个已保存裁片：身份 + 原图坐标区域。 */
export interface SavedCrop {
  /** 会话内唯一且不复用的身份（如 "crop-1"），贯穿预览、清单与打包。 */
  id: string;
  /** 用户给的唯一名称（已归一化：去首尾空白、压缩连续空白）。 */
  name: string;
  /** 原始图像像素坐标下的半开矩形 [x, x+width) × [y, y+height)。 */
  originalRect: Rect;
}

/** 裁片数量上限。 */
export const MAX_CROPS = 8;

/** 裁片名称长度上限（归一化后）。 */
export const MAX_NAME_LENGTH = 40;

/** 归一化名称：去首尾空白并把连续空白压缩为单个空格。 */
export function normalizeCropName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** 名称是否可用：返回 null 表示可用，否则返回原因。 */
export function cropNameError(name: string, existing: readonly SavedCrop[]): string | null {
  if (name.length === 0) return '名称不能为空';
  if (name.length > MAX_NAME_LENGTH) return `名称过长（上限 ${MAX_NAME_LENGTH} 字符）`;
  if (existing.some((c) => c.name === name)) return `名称「${name}」已存在`;
  return null;
}

/**
 * 向批次追加裁片（纯函数，返回新数组，不改传入列表）。
 * 校验：数量上限、id 唯一、名称唯一且合法、原图矩形有效。
 * 任一不满足即抛错——非法输入绝不静默覆盖已保存项。
 */
export function addCrop(
  list: readonly SavedCrop[],
  crop: SavedCrop,
  raw: Size,
): SavedCrop[] {
  if (list.length >= MAX_CROPS) {
    throw new Error(`裁片数量已达上限 ${MAX_CROPS}`);
  }
  if (list.some((c) => c.id === crop.id)) {
    throw new Error(`裁片 id 重复：${crop.id}`);
  }
  const nameProblem = cropNameError(crop.name, list);
  if (nameProblem !== null) {
    throw new Error(nameProblem);
  }
  if (!isValidRect(crop.originalRect, raw)) {
    throw new Error(`裁片区域在原图 ${raw.width}x${raw.height} 内无效`);
  }
  return [...list, crop];
}

/** 按身份移除裁片（纯函数，返回新数组）。 */
export function removeCrop(list: readonly SavedCrop[], id: string): SavedCrop[] {
  return list.filter((c) => c.id !== id);
}

/**
 * 原图矩形 → 指定方向下的显示矩形。
 * 对原图矩形覆盖的像素单元四角逐一做正向映射，再取轴对齐包围盒；
 * 与 mapRectToOriginal 互为逆运算（镜像/旋转下同样成立）。
 */
export function mapRectToDisplay(
  originalRect: Rect,
  raw: Size,
  orientation: Orientation,
): Rect {
  if (!isValidRect(originalRect, raw)) {
    throw new Error(`invalid original rect for ${raw.width}x${raw.height} image`);
  }
  const cells = [
    { x: originalRect.x, y: originalRect.y },
    { x: originalRect.x + originalRect.width - 1, y: originalRect.y },
    { x: originalRect.x, y: originalRect.y + originalRect.height - 1 },
    {
      x: originalRect.x + originalRect.width - 1,
      y: originalRect.y + originalRect.height - 1,
    },
  ];
  const mapped = cells.map(({ x, y }) => forwardMap(x, y, raw, orientation));
  const us = mapped.map((p) => p.u);
  const vs = mapped.map((p) => p.v);
  const u0 = Math.min(...us);
  const v0 = Math.min(...vs);
  return {
    x: u0,
    y: v0,
    width: Math.max(...us) - u0 + 1,
    height: Math.max(...vs) - v0 + 1,
  };
}
