/**
 * 多裁片工作区：裁片身份、批次规则与跨方向重投影。
 *
 * 每个已保存裁片（CropItem）以「原始（存储方向）像素坐标」记录区域，
 * 与图片内容一一对应、不随 EXIF 方向选择而变；切换方向后显示矩形
 * 一律由 displayRectForCrop 重新投影得到，绝不复用旧方向的显示坐标。
 *
 * 核心映射、批次状态、打包与页面预览共享同一 CropItem 身份（id）。
 */
import { Orientation, Rect, Size } from './orientation';
import { mapRectToDisplay, mapRectToOriginal } from './crop';

/** 一个批次至多保存的裁片数量。 */
export const MAX_CROPS = 8;

/** 裁片名称的最大长度（裁剪后计入）。 */
export const MAX_NAME_LENGTH = 64;

/** 已保存裁片：区域始终以原图像素坐标记录的半开矩形。 */
export interface CropItem {
  /** 稳定身份：批次状态、打包清单与页面预览共用同一 id。 */
  id: string;
  /** 唯一名称（裁剪首尾空白后），同时用作包内 PNG 文件名主体。 */
  name: string;
  /** 原始（存储方向）像素坐标系中的半开矩形。 */
  rect: Rect;
}

/**
 * 校验裁片名称：非空、长度有限、不含文件名非法字符、
 * 与批次内现有名称不重复（大小写不敏感，避免包内文件名歧义）。
 * 返回 null 表示合法，否则返回错误原因。
 */
export function validateCropName(name: string, items: readonly CropItem[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return '名称不能为空';
  if (trimmed.length > MAX_NAME_LENGTH) return `名称过长（至多 ${MAX_NAME_LENGTH} 字符）`;
  if (/[\\/:*?"<>|\x00-\x1f]/.test(trimmed)) return '名称含文件名非法字符';
  if (items.some((it) => it.name.toLowerCase() === trimmed.toLowerCase())) {
    return '名称已存在';
  }
  return null;
}

/** 批次是否还能继续保存裁片。 */
export function canAddCrop(items: readonly CropItem[]): boolean {
  return items.length < MAX_CROPS;
}

/**
 * 由当前显示矩形构造裁片：区域立即逆变换为原图坐标记录。
 * 显示矩形非法（零面积/越界）时抛错——非法手势不得产生、也不得覆盖已保存项。
 */
export function createCropItem(
  id: string,
  name: string,
  displayRect: Rect,
  raw: Size,
  orientation: Orientation,
): CropItem {
  return {
    id,
    name: name.trim(),
    rect: mapRectToOriginal(displayRect, raw, orientation),
  };
}

/** 把裁片加入批次（不可变：返回新数组）。违反批次规则时抛错。 */
export function addCropItem(items: readonly CropItem[], item: CropItem): CropItem[] {
  if (!canAddCrop(items)) {
    throw new Error(`最多保存 ${MAX_CROPS} 个裁片`);
  }
  const nameError = validateCropName(item.name, items);
  if (nameError) {
    throw new Error(nameError);
  }
  if (items.some((it) => it.id === item.id)) {
    throw new Error(`裁片 id 已存在：${item.id}`);
  }
  return [...items, item];
}

/** 按 id 移除裁片（不可变：返回新数组）。 */
export function removeCropItem(items: readonly CropItem[], id: string): CropItem[] {
  return items.filter((it) => it.id !== id);
}

/**
 * 裁片在指定方向下的显示矩形：由原图坐标经 forwardMap 逐角重投影。
 * 这是切换 EXIF 方向后显示已保存裁片的唯一途径。
 */
export function displayRectForCrop(
  item: CropItem,
  raw: Size,
  orientation: Orientation,
): Rect {
  return mapRectToDisplay(item.rect, raw, orientation);
}
