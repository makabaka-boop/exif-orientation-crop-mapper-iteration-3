/**
 * 交付打包：由「同一图片 + 同一方向 + 裁片列表」的快照生成清单，
 * 逐项把裁片身份绑定到原图矩形、显示矩形与包内文件名。
 *
 * 清单与 PNG 内容使用与单裁片导出完全相同的核心映射
 * （mapRectToDisplay / mapCornersToOriginal / exportCrop），
 * 保证包内数据与页面预览一致、可复核。
 */
import { Orientation, Rect, Size, orientedSize } from './orientation';
import { MappedCorner, mapCornersToOriginal } from './crop';
import { SavedCrop, mapRectToDisplay } from './batch';

/** 包内清单文件名。 */
export const MANIFEST_FILE_NAME = 'manifest.json';

/** 生成交付包所需的不可变快照。 */
export interface PackageSnapshot {
  image: { name: string; type: string; width: number; height: number };
  orientation: Orientation;
  crops: readonly SavedCrop[];
}

/** 清单中的单个裁片条目：身份 + 文件名 + 双向坐标。 */
export interface ManifestCropEntry {
  id: string;
  name: string;
  /** 该裁片在 ZIP 内的 PNG 文件名。 */
  file: string;
  display: { width: number; height: number; rect: Rect };
  original: { rect: Rect; corners: MappedCorner[] };
}

export interface PackageManifest {
  version: 1;
  image: { name: string; type: string; width: number; height: number };
  orientation: Orientation;
  display: Size;
  crops: ManifestCropEntry[];
  coordinateSystem: string;
}

/** 文件名净化：替换路径分隔符与控制字符，空名称回退为 "crop"。 */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'crop';
}

/**
 * 裁片在包内的 PNG 文件名：序号前缀 + 净化后的名称。
 * 序号来自快照中的列表顺序，保证即使净化后重名也互不冲突。
 */
export function cropFileName(index: number, name: string): string {
  return `${String(index + 1).padStart(2, '0')}-${sanitizeFileName(name)}.png`;
}

/**
 * 由快照构建清单。每个条目的显示矩形由保存的原图矩形
 * 按快照方向重新投影得到——与页面 overlay 用的是同一函数。
 */
export function buildManifest(snapshot: PackageSnapshot): PackageManifest {
  const raw: Size = { width: snapshot.image.width, height: snapshot.image.height };
  const display = orientedSize(raw, snapshot.orientation);
  return {
    version: 1,
    image: { ...snapshot.image },
    orientation: snapshot.orientation,
    display,
    crops: snapshot.crops.map((crop, index) => {
      const displayRect = mapRectToDisplay(crop.originalRect, raw, snapshot.orientation);
      return {
        id: crop.id,
        name: crop.name,
        file: cropFileName(index, crop.name),
        display: { width: display.width, height: display.height, rect: displayRect },
        original: {
          rect: { ...crop.originalRect },
          corners: mapCornersToOriginal(displayRect, raw, snapshot.orientation),
        },
      };
    }),
    coordinateSystem:
      'original-image pixel coordinates, origin top-left, half-open [x, x+width) x [y, y+height)',
  };
}
