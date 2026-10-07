/**
 * 极简 ZIP 写入器（纯函数，无依赖）。
 *
 * 仅使用 STORE（不压缩）条目：裁片 PNG 本身已压缩，再压缩无收益，
 * 且固定时间戳使同一快照产出逐字节一致的包，便于复核与测试。
 */

export interface ZipEntry {
  /** 包内路径（UTF-8，使用 '/' 分隔，禁止以 '/' 开头）。 */
  name: string;
  data: Uint8Array;
}

/** 标准 CRC-32（多项式 0xEDB88320），ZIP 条目完整性校验用。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 固定 DOS 时间戳（1980-01-01 00:00:00）：输出确定性，不泄漏打包时间。 */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
/** 通用标志位 11：文件名按 UTF-8 编码。 */
const FLAG_UTF8 = 0x0800;
const VERSION = 20;
const METHOD_STORE = 0;

/**
 * 把若干条目打包为一个 ZIP 文件的字节序列。
 * 条目顺序即包内顺序；调用方需保证文件名唯一。
 */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); // local file header
    local.setUint16(4, VERSION, true);
    local.setUint16(6, FLAG_UTF8, true);
    local.setUint16(8, METHOD_STORE, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true); // compressed = uncompressed（STORE）
    local.setUint32(22, size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true); // extra length
    localParts.push(new Uint8Array(local.buffer), name, entry.data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); // central directory header
    central.setUint16(4, VERSION, true); // version made by
    central.setUint16(6, VERSION, true); // version needed
    central.setUint16(8, FLAG_UTF8, true);
    central.setUint16(10, METHOD_STORE, true);
    central.setUint16(12, DOS_TIME, true);
    central.setUint16(14, DOS_DATE, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, name.length, true);
    // 30 extra / 32 comment / 34 disk / 36 internal / 38 external 均为 0
    central.setUint32(42, offset, true); // local header 偏移
    centralParts.push(new Uint8Array(central.buffer), name);

    offset += 30 + name.length + size;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true); // end of central directory
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralOffset, true);

  const total = offset + centralSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of [...localParts, ...centralParts, new Uint8Array(eocd.buffer)]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
