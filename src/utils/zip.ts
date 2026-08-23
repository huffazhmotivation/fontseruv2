export interface BrowserZipEntry {
  name: string;
  blob: Blob;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()));
  const month = Math.max(1, Math.min(12, date.getMonth() + 1));
  const day = Math.max(1, Math.min(31, date.getDate()));
  const hours = Math.max(0, Math.min(23, date.getHours()));
  const minutes = Math.max(0, Math.min(59, date.getMinutes()));
  const seconds = Math.max(0, Math.min(59, date.getSeconds()));

  return {
    time: ((hours << 11) | (minutes << 5) | Math.floor(seconds / 2)) & 0xffff,
    date: (((year - 1980) << 9) | (month << 5) | day) & 0xffff,
  };
}

function writeU16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value & 0xffff, true);
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

/**
 * Build a standards-compliant ZIP in the browser without another dependency.
 * Entries use the STORE method (no compression), which is appropriate for
 * already compact binary font files and keeps export deterministic.
 */
export async function createZipBlob(entries: BrowserZipEntry[]): Promise<Blob> {
  if (!entries.length) throw new Error("Cannot create an empty ZIP archive.");

  const encoder = new TextEncoder();
  const stamp = dosDateTime(new Date());
  const prepared = await Promise.all(entries.map(async (entry) => {
    const name = entry.name.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!name || name.endsWith("/")) throw new Error("ZIP entry has an invalid file name.");
    const nameBytes = encoder.encode(name);
    const data = new Uint8Array(await entry.blob.arrayBuffer());
    return {
      nameBytes,
      data,
      crc: crc32(data),
      size: data.byteLength,
      localOffset: 0,
    };
  }));

  let localSize = 0;
  for (const entry of prepared) {
    localSize += 30 + entry.nameBytes.length + entry.size;
  }

  let centralSize = 0;
  for (const entry of prepared) {
    centralSize += 46 + entry.nameBytes.length;
  }

  const totalSize = localSize + centralSize + 22;
  if (totalSize > 0xffffffff) throw new Error("ZIP archive is too large.");

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let offset = 0;

  for (const entry of prepared) {
    entry.localOffset = offset;
    writeU32(view, offset, 0x04034b50);
    writeU16(view, offset + 4, 20);      // version needed
    writeU16(view, offset + 6, 0x0800);  // UTF-8 file names
    writeU16(view, offset + 8, 0);       // STORE
    writeU16(view, offset + 10, stamp.time);
    writeU16(view, offset + 12, stamp.date);
    writeU32(view, offset + 14, entry.crc);
    writeU32(view, offset + 18, entry.size);
    writeU32(view, offset + 22, entry.size);
    writeU16(view, offset + 26, entry.nameBytes.length);
    writeU16(view, offset + 28, 0);
    out.set(entry.nameBytes, offset + 30);
    out.set(entry.data, offset + 30 + entry.nameBytes.length);
    offset += 30 + entry.nameBytes.length + entry.size;
  }

  const centralOffset = offset;
  for (const entry of prepared) {
    writeU32(view, offset, 0x02014b50);
    writeU16(view, offset + 4, 20);      // version made by
    writeU16(view, offset + 6, 20);      // version needed
    writeU16(view, offset + 8, 0x0800);  // UTF-8 file names
    writeU16(view, offset + 10, 0);      // STORE
    writeU16(view, offset + 12, stamp.time);
    writeU16(view, offset + 14, stamp.date);
    writeU32(view, offset + 16, entry.crc);
    writeU32(view, offset + 20, entry.size);
    writeU32(view, offset + 24, entry.size);
    writeU16(view, offset + 28, entry.nameBytes.length);
    writeU16(view, offset + 30, 0);      // extra length
    writeU16(view, offset + 32, 0);      // comment length
    writeU16(view, offset + 34, 0);      // disk number
    writeU16(view, offset + 36, 0);      // internal attrs
    writeU32(view, offset + 38, 0);      // external attrs
    writeU32(view, offset + 42, entry.localOffset);
    out.set(entry.nameBytes, offset + 46);
    offset += 46 + entry.nameBytes.length;
  }

  const writtenCentralSize = offset - centralOffset;
  writeU32(view, offset, 0x06054b50);
  writeU16(view, offset + 4, 0);
  writeU16(view, offset + 6, 0);
  writeU16(view, offset + 8, prepared.length);
  writeU16(view, offset + 10, prepared.length);
  writeU32(view, offset + 12, writtenCentralSize);
  writeU32(view, offset + 16, centralOffset);
  writeU16(view, offset + 20, 0);

  return new Blob([out], { type: "application/zip" });
}
