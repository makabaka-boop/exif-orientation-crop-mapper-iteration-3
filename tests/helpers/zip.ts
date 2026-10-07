/**
 * 测试用 ZIP 读取器：解析中央目录并逐条校验 CRC，
 * 用于核对 buildZip 产物的结构与内容。
 */
import { crc32 } from '../../src/core/zip';

export interface UnzippedEntry {
  name: string;
  data: Uint8Array;
}

export function unzip(bytes: Uint8Array): UnzippedEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 从尾部扫描 EOCD 签名（本工具不写归档注释，取第一个匹配即可）
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('EOCD not found');

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const out: UnzippedEntry[] = [];

  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) {
      throw new Error(`central directory header ${n} has bad signature`);
    }
    const crc = view.getUint32(p + 16, true);
    const compressed = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    if (compressed !== size) throw new Error('expected STORE (no compression)');
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const local = view.getUint32(p + 42, true);

    if (view.getUint32(local, true) !== 0x04034b50) {
      throw new Error(`local header of ${name} has bad signature`);
    }
    const localNameLen = view.getUint16(local + 26, true);
    const localExtraLen = view.getUint16(local + 28, true);
    const dataStart = local + 30 + localNameLen + localExtraLen;
    const data = bytes.slice(dataStart, dataStart + size);
    if (crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);

    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
