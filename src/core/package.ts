/**
 * 多裁片交付打包：从同一图片、方向与裁片列表快照生成一个 ZIP，
 * 内含各裁片的正向无缩放 PNG 与逐项绑定原图/显示矩形/文件名的清单。
 *
 * 作废规则：任一 PNG 编码失败，或生成期间图片、方向、裁片列表发生
 * 变更（isStale() 为真），整个包不得交付——调用方拿不到 ZIP 字节。
 */
import { Orientation, PixelImage, Rect, Size, orientedSize } from './orientation';
import { MappedCorner, exportCrop, mapCornersToOriginal } from './crop';
import { CropItem, displayRectForCrop } from './crops';
import { ZipEntry, buildZip } from './zip';

/** 清单在包内的固定文件名。 */
export const MANIFEST_FILE = 'manifest.json';

/** 清单中的单项：把一个裁片身份绑定到原图矩形、显示矩形与包内文件名。 */
export interface PackageManifestEntry {
  id: string;
  name: string;
  /** 包内 PNG 文件名（由裁片名称派生）。 */
  file: string;
  display: {
    width: number;
    height: number;
    rect: Rect;
  };
  original: {
    rect: Rect;
    corners: MappedCorner[];
  };
}

export interface CropPackageManifest {
  image: {
    name: string;
    type: string;
    width: number;
    height: number;
  };
  orientation: Orientation;
  coordinateSystem: string;
  crops: PackageManifestEntry[];
}

/** 裁片名称 → 包内 PNG 文件名。 */
export function cropFileName(name: string): string {
  return `${name}.png`;
}

/**
 * 由裁片列表快照生成清单。每个裁片的显示矩形按其原图坐标在
 * 当前方向下重投影得到，与包内 PNG 使用同一份映射结果。
 */
export function buildPackageManifest(
  raw: Size,
  file: { name: string; type: string },
  orientation: Orientation,
  items: readonly CropItem[],
): CropPackageManifest {
  const display = orientedSize(raw, orientation);
  return {
    image: { name: file.name, type: file.type, width: raw.width, height: raw.height },
    orientation,
    coordinateSystem:
      'original-image pixel coordinates, origin top-left, half-open [x, x+width) x [y, y+height)',
    crops: items.map((item) => {
      const rect = displayRectForCrop(item, raw, orientation);
      return {
        id: item.id,
        name: item.name,
        file: cropFileName(item.name),
        display: { width: display.width, height: display.height, rect },
        original: {
          rect: { ...item.rect },
          corners: mapCornersToOriginal(rect, raw, orientation),
        },
      };
    }),
  };
}

/** PNG 编码器：把正向裁片像素编码为 PNG 字节。浏览器端用 canvas 实现，测试可注入。 */
export type EncodePng = (img: PixelImage) => Promise<Uint8Array>;

export type PackageFailure = 'empty' | 'invalid' | 'stale' | 'encode-failed';

export type PackageResult =
  | { ok: true; manifest: CropPackageManifest; zip: Uint8Array }
  | { ok: false; reason: PackageFailure };

/**
 * 从快照打包裁片。
 *
 * @param raw      原始（存储方向）像素
 * @param file     图片来源文件信息
 * @param items    裁片列表快照（原图坐标），打包期间不得再变
 * @param encodePng PNG 编码器；任一裁片编码失败则整包作废
 * @param isStale  状态探针：图片/方向/裁片列表在生成期间是否已变更
 */
export async function buildCropPackage(
  raw: PixelImage,
  file: { name: string; type: string },
  orientation: Orientation,
  items: readonly CropItem[],
  encodePng: EncodePng,
  isStale: () => boolean = () => false,
): Promise<PackageResult> {
  if (items.length === 0) return { ok: false, reason: 'empty' };

  // 先整体校验快照：id/名称唯一、区域在原图内合法，避免交付半成品。
  let manifest: CropPackageManifest;
  try {
    const ids = new Set(items.map((it) => it.id));
    const names = new Set(items.map((it) => it.name.toLowerCase()));
    if (ids.size !== items.length || names.size !== items.length) {
      throw new Error('duplicate crop id or name');
    }
    manifest = buildPackageManifest(raw, file, orientation, items);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (isStale()) return { ok: false, reason: 'stale' };

  const entries: ZipEntry[] = [];
  for (const entry of manifest.crops) {
    // 清单中的显示矩形与 PNG 像素同源：同一份重投影结果。
    const crop = exportCrop(raw, entry.display.rect, orientation);
    let bytes: Uint8Array;
    try {
      bytes = await encodePng(crop);
    } catch {
      return { ok: false, reason: 'encode-failed' };
    }
    // 每次异步编码后都复查：期间换图/改方向/改裁片则整包作废。
    if (isStale()) return { ok: false, reason: 'stale' };
    entries.push({ name: entry.file, data: bytes });
  }

  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  const zip = buildZip([{ name: MANIFEST_FILE, data: manifestBytes }, ...entries]);
  return { ok: true, manifest, zip };
}
