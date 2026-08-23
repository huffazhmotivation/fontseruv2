
export interface TrueTypePoint {
  x: number;
  y: number;
}

export interface TrueTypeNode {
  point: TrueTypePoint;
  handleIn?: TrueTypePoint | null;
  handleOut?: TrueTypePoint | null;
}

export interface TrueTypeContourInput {
  nodes: TrueTypeNode[];
}

export interface TrueTypeGlyphInput {
  name: string;
  unicodes: number[];
  advanceWidth: number;
  contours: TrueTypeContourInput[];
}

export interface TrueTypeMetadata {
  familyName: string;
  subfamilyName: string;
  fullName: string;
  postScriptName: string;
  version: string;
  creator: string;
  manufacturer: string;
  manufacturerURL?: string;
  uniqueID: string;
  copyright: string;
  description?: string;
  license: string;
  licenseURL?: string;
  /** Desktop family/style-link metadata. */
  weightClass: number;
  fsSelection: number;
  macStyle: number;
  italicAngle: number;
}

export interface TrueTypeFontInput {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  capHeight: number;
  xHeight: number;
  metadata: TrueTypeMetadata;
  glyphs: TrueTypeGlyphInput[];
}

export interface TrueTypeFontResult {
  buffer: ArrayBuffer;
  glyphIndexByUnicode: Map<number, number>;
}

interface TTPoint {
  x: number;
  y: number;
  onCurve: boolean;
}

interface EncodedGlyph {
  data: Uint8Array;
  bbox: BBox;
  advanceWidth: number;
  lsb: number;
  pointCount: number;
  contourCount: number;
}

interface BBox {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
}

interface TableRecord {
  tag: string;
  data: Uint8Array;
}

const SFNT_CHECKSUM_MAGIC = 0xB1B0AFBA;
const MAX_I16 = 32767;
const MIN_I16 = -32768;
const MAX_U16 = 65535;

function clampI16(value: number): number {
  return Math.max(MIN_I16, Math.min(MAX_I16, Math.round(value)));
}

function clampU16(value: number): number {
  return Math.max(0, Math.min(MAX_U16, Math.round(value)));
}

function isFinitePoint(point: TrueTypePoint | null | undefined): point is TrueTypePoint {
  return !!point && Number.isFinite(point.x) && Number.isFinite(point.y);
}

function midpoint(a: TrueTypePoint, b: TrueTypePoint): TrueTypePoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}


function cubicAt(p0: TrueTypePoint, p1: TrueTypePoint, p2: TrueTypePoint, p3: TrueTypePoint, t: number): TrueTypePoint {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function quadraticAt(p0: TrueTypePoint, q: TrueTypePoint, p2: TrueTypePoint, t: number): TrueTypePoint {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * q.x + t * t * p2.x,
    y: mt * mt * p0.y + 2 * mt * t * q.y + t * t * p2.y,
  };
}

function distance(a: TrueTypePoint, b: TrueTypePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

interface QuadraticSegment {
  control: TrueTypePoint;
  end: TrueTypePoint;
}

function approximateCubic(
  p0: TrueTypePoint,
  p1: TrueTypePoint,
  p2: TrueTypePoint,
  p3: TrueTypePoint,
  tolerance: number,
  depth = 0,
): QuadraticSegment[] {
  // Pick the quadratic control point that exactly matches the cubic at t=.5.
  const control = {
    x: (3 * p1.x + 3 * p2.x - p0.x - p3.x) / 4,
    y: (3 * p1.y + 3 * p2.y - p0.y - p3.y) / 4,
  };

  let error = 0;
  for (const t of [0.25, 0.75]) {
    error = Math.max(
      error,
      distance(cubicAt(p0, p1, p2, p3, t), quadraticAt(p0, control, p3, t)),
    );
  }

  if (error <= tolerance || depth >= 8) {
    return [{ control, end: p3 }];
  }

  // de Casteljau split at t=.5.
  const p01 = midpoint(p0, p1);
  const p12 = midpoint(p1, p2);
  const p23 = midpoint(p2, p3);
  const p012 = midpoint(p01, p12);
  const p123 = midpoint(p12, p23);
  const split = midpoint(p012, p123);

  return [
    ...approximateCubic(p0, p01, p012, split, tolerance, depth + 1),
    ...approximateCubic(split, p123, p23, p3, tolerance, depth + 1),
  ];
}

function sameCoords(a: TTPoint, b: TTPoint): boolean {
  return a.x === b.x && a.y === b.y;
}

function pushPoint(points: TTPoint[], point: TrueTypePoint, onCurve: boolean): void {
  if (!isFinitePoint(point)) return;
  const next: TTPoint = { x: clampI16(point.x), y: clampI16(point.y), onCurve };
  const prev = points[points.length - 1];
  if (prev && prev.onCurve === next.onCurve && sameCoords(prev, next)) return;
  points.push(next);
}

function contourToTrueType(contour: TrueTypeContourInput, tolerance: number): TTPoint[] {
  const nodes = (contour.nodes ?? []).filter((node) => isFinitePoint(node?.point));
  if (nodes.length < 2) return [];

  const points: TTPoint[] = [];
  pushPoint(points, nodes[0].point, true);

  for (let i = 0; i < nodes.length; i++) {
    const from = nodes[i];
    const to = nodes[(i + 1) % nodes.length];
    const closing = i === nodes.length - 1;
    const p0 = from.point;
    const p3 = to.point;
    const hasCurve = isFinitePoint(from.handleOut) || isFinitePoint(to.handleIn);

    if (!hasCurve) {
      if (!closing) pushPoint(points, p3, true);
      continue;
    }

    const p1 = isFinitePoint(from.handleOut) ? from.handleOut : p0;
    const p2 = isFinitePoint(to.handleIn) ? to.handleIn : p3;
    const quadratics = approximateCubic(p0, p1, p2, p3, tolerance);
    quadratics.forEach((segment, qIndex) => {
      pushPoint(points, segment.control, false);
      const finalClosingEnd = closing && qIndex === quadratics.length - 1;
      if (!finalClosingEnd) pushPoint(points, segment.end, true);
    });
  }

  // The contour closes implicitly. Avoid a duplicate terminal copy of start.
  if (points.length > 1 && points[0].onCurve && points[points.length - 1].onCurve && sameCoords(points[0], points[points.length - 1])) {
    points.pop();
  }

  return points.length >= 2 ? points : [];
}

class ByteWriter {
  private bytes: number[] = [];

  get length(): number { return this.bytes.length; }

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  i8(value: number): this {
    return this.u8(value);
  }

  u16(value: number): this {
    const v = value & 0xffff;
    this.bytes.push((v >>> 8) & 0xff, v & 0xff);
    return this;
  }

  i16(value: number): this {
    return this.u16(value);
  }

  u32(value: number): this {
    const v = value >>> 0;
    this.bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
    return this;
  }

  i32(value: number): this {
    return this.u32(value);
  }

  tag(value: string): this {
    for (let i = 0; i < 4; i++) this.u8(value.charCodeAt(i) || 0x20);
    return this;
  }

  raw(value: Uint8Array): this {
    for (const byte of value) this.bytes.push(byte);
    return this;
  }

  pad4(): this {
    while (this.bytes.length % 4) this.u8(0);
    return this;
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function bboxForPoints(points: TTPoint[]): BBox {
  if (!points.length) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  let xMin = points[0].x;
  let yMin = points[0].y;
  let xMax = points[0].x;
  let yMax = points[0].y;
  for (const point of points) {
    xMin = Math.min(xMin, point.x);
    yMin = Math.min(yMin, point.y);
    xMax = Math.max(xMax, point.x);
    yMax = Math.max(yMax, point.y);
  }
  return { xMin, yMin, xMax, yMax };
}

function unionBBox(a: BBox, b: BBox): BBox {
  return {
    xMin: Math.min(a.xMin, b.xMin),
    yMin: Math.min(a.yMin, b.yMin),
    xMax: Math.max(a.xMax, b.xMax),
    yMax: Math.max(a.yMax, b.yMax),
  };
}


function flagForDelta(delta: number, shortBit: number, sameBit: number): number {
  if (delta === 0) return sameBit;
  if (Math.abs(delta) <= 255) return shortBit | (delta > 0 ? sameBit : 0);
  return 0;
}

function writeDelta(writer: ByteWriter, delta: number, shortBitSet: boolean, sameBitSet: boolean): void {
  if (shortBitSet) {
    writer.u8(Math.abs(delta));
  } else if (!sameBitSet) {
    writer.i16(delta);
  }
}

function encodeSimpleGlyph(contours: TTPoint[][], advanceWidth: number): EncodedGlyph {
  const usable = contours.filter((contour) => contour.length >= 2);
  if (!usable.length) {
    return {
      data: new Uint8Array(0),
      bbox: { xMin: 0, yMin: 0, xMax: 0, yMax: 0 },
      advanceWidth: clampU16(Math.max(1, advanceWidth)),
      lsb: 0,
      pointCount: 0,
      contourCount: 0,
    };
  }

  const allPoints = usable.flat();
  const bbox = bboxForPoints(allPoints);
  const writer = new ByteWriter();
  writer.i16(usable.length);
  writer.i16(bbox.xMin).i16(bbox.yMin).i16(bbox.xMax).i16(bbox.yMax);

  let pointCursor = -1;
  for (const contour of usable) {
    pointCursor += contour.length;
    writer.u16(pointCursor);
  }

  writer.u16(0); // instructionLength

  const flags: number[] = [];
  let prevX = 0;
  let prevY = 0;
  const xDeltas: number[] = [];
  const yDeltas: number[] = [];

  for (const point of allPoints) {
    const dx = point.x - prevX;
    const dy = point.y - prevY;
    prevX = point.x;
    prevY = point.y;
    xDeltas.push(dx);
    yDeltas.push(dy);

    let flag = point.onCurve ? 0x01 : 0;
    flag |= flagForDelta(dx, 0x02, 0x10);
    flag |= flagForDelta(dy, 0x04, 0x20);
    flags.push(flag);
    writer.u8(flag);
  }

  for (let i = 0; i < allPoints.length; i++) {
    const flag = flags[i];
    writeDelta(writer, xDeltas[i], (flag & 0x02) !== 0, (flag & 0x10) !== 0);
  }
  for (let i = 0; i < allPoints.length; i++) {
    const flag = flags[i];
    writeDelta(writer, yDeltas[i], (flag & 0x04) !== 0, (flag & 0x20) !== 0);
  }

  const aw = clampU16(Math.max(1, advanceWidth));
  return {
    data: writer.toUint8Array(),
    bbox,
    advanceWidth: aw,
    lsb: bbox.xMin,
    pointCount: allPoints.length,
    contourCount: usable.length,
  };
}

function buildGlyphs(input: TrueTypeFontInput): {
  glyphs: EncodedGlyph[];
  glyphIndexByUnicode: Map<number, number>;
  locaOffsets: number[];
  glyf: Uint8Array;
  globalBBox: BBox;
  maxPoints: number;
  maxContours: number;
} {
  const tolerance = Math.max(0.5, input.unitsPerEm / 2048);
  const glyphs: EncodedGlyph[] = [];
  const glyphIndexByUnicode = new Map<number, number>();

  // Glyph 0 is always .notdef.
  glyphs.push(encodeSimpleGlyph([], Math.round(input.unitsPerEm * 0.5)));

  input.glyphs.forEach((glyph, index) => {
    const contours = (glyph.contours ?? [])
      .map((contour) => contourToTrueType(contour, tolerance))
      .filter((contour) => contour.length >= 2);
    glyphs.push(encodeSimpleGlyph(contours, glyph.advanceWidth));
    const gid = index + 1;
    for (const cp of glyph.unicodes ?? []) {
      if (
        Number.isInteger(cp)
        && cp >= 0
        && cp <= 0x10ffff
        && !(cp >= 0xd800 && cp <= 0xdfff)
        && !glyphIndexByUnicode.has(cp)
      ) {
        glyphIndexByUnicode.set(cp, gid);
      }
    }
  });

  const writer = new ByteWriter();
  const locaOffsets: number[] = [0];
  for (const glyph of glyphs) {
    writer.raw(glyph.data);
    writer.pad4();
    locaOffsets.push(writer.length);
  }

  let globalBBox: BBox = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  let hasBBox = false;
  let maxPoints = 0;
  let maxContours = 0;
  for (const glyph of glyphs) {
    if (glyph.pointCount > 0) {
      globalBBox = hasBBox ? unionBBox(globalBBox, glyph.bbox) : { ...glyph.bbox };
      hasBBox = true;
    }
    maxPoints = Math.max(maxPoints, glyph.pointCount);
    maxContours = Math.max(maxContours, glyph.contourCount);
  }

  return {
    glyphs,
    glyphIndexByUnicode,
    locaOffsets,
    glyf: writer.toUint8Array(),
    globalBBox,
    maxPoints,
    maxContours,
  };
}

function buildLoca(offsets: number[]): Uint8Array {
  const writer = new ByteWriter();
  for (const offset of offsets) writer.u32(offset);
  return writer.toUint8Array();
}

function buildHmtx(glyphs: EncodedGlyph[]): Uint8Array {
  const writer = new ByteWriter();
  for (const glyph of glyphs) writer.u16(glyph.advanceWidth).i16(glyph.lsb);
  return writer.toUint8Array();
}

function writeLongDateTime(writer: ByteWriter, secondsSince1904: number): void {
  const value = Math.max(0, Math.floor(secondsSince1904));
  writer.u32(Math.floor(value / 0x100000000));
  writer.u32(value >>> 0);
}

function fontRevision(version: string): number {
  const parsed = Number.parseFloat(version);
  const value = Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
  return Math.max(0, Math.min(0xffffffff, Math.round(value * 65536))) >>> 0;
}

function buildHead(input: TrueTypeFontInput, bbox: BBox): Uint8Array {
  const writer = new ByteWriter();
  writer.u32(0x00010000); // version
  writer.u32(fontRevision(input.metadata.version)); // fontRevision
  writer.u32(0); // checkSumAdjustment, patched after assembly
  writer.u32(0x5F0F3CF5); // magicNumber
  writer.u16(0x0001); // baseline for font at y=0
  writer.u16(clampU16(input.unitsPerEm));
  const nowMacSeconds = Date.now() / 1000 + 2082844800;
  writeLongDateTime(writer, nowMacSeconds); // created
  writeLongDateTime(writer, nowMacSeconds); // modified
  writer.i16(bbox.xMin).i16(bbox.yMin).i16(bbox.xMax).i16(bbox.yMax);
  writer.u16(clampU16(input.metadata.macStyle)); // macStyle: BOLD/ITALIC family-link flags
  writer.u16(8); // lowestRecPPEM
  writer.i16(2); // fontDirectionHint
  writer.i16(1); // indexToLocFormat: long
  writer.i16(0); // glyphDataFormat
  return writer.toUint8Array();
}

function buildHhea(input: TrueTypeFontInput, glyphs: EncodedGlyph[]): Uint8Array {
  const writer = new ByteWriter();
  const maxAdvance = glyphs.reduce((max, glyph) => Math.max(max, glyph.advanceWidth), 0);
  const minLsb = glyphs.reduce((min, glyph) => Math.min(min, glyph.lsb), 0);
  const minRsb = glyphs.reduce((min, glyph) => {
    const rsb = glyph.advanceWidth - glyph.bbox.xMax;
    return Math.min(min, rsb);
  }, 0);
  const maxExtent = glyphs.reduce((max, glyph) => Math.max(max, glyph.bbox.xMax), 0);

  writer.u32(0x00010000);
  writer.i16(clampI16(input.ascender));
  writer.i16(clampI16(input.descender));
  writer.i16(0); // lineGap
  writer.u16(clampU16(maxAdvance));
  writer.i16(clampI16(minLsb));
  writer.i16(clampI16(minRsb));
  writer.i16(clampI16(maxExtent));
  writer.i16(1); // caretSlopeRise
  writer.i16(0); // caretSlopeRun
  writer.i16(0); // caretOffset
  writer.i16(0).i16(0).i16(0).i16(0); // reserved
  writer.i16(0); // metricDataFormat
  writer.u16(glyphs.length);
  return writer.toUint8Array();
}

function buildMaxp(glyphCount: number, maxPoints: number, maxContours: number): Uint8Array {
  const writer = new ByteWriter();
  writer.u32(0x00010000);
  writer.u16(glyphCount);
  writer.u16(Math.min(MAX_U16, maxPoints));
  writer.u16(Math.min(MAX_U16, maxContours));
  writer.u16(0); // maxCompositePoints
  writer.u16(0); // maxCompositeContours
  writer.u16(2); // maxZones
  writer.u16(0); // maxTwilightPoints
  writer.u16(0); // maxStorage
  writer.u16(0); // maxFunctionDefs
  writer.u16(0); // maxInstructionDefs
  writer.u16(0); // maxStackElements
  writer.u16(0); // maxSizeOfInstructions
  writer.u16(0); // maxComponentElements
  writer.u16(0); // maxComponentDepth
  return writer.toUint8Array();
}

function buildPost(input: TrueTypeFontInput): Uint8Array {
  const writer = new ByteWriter();
  writer.u32(0x00030000); // version 3.0: no glyph name strings
  writer.i32(Math.round(input.metadata.italicAngle * 65536)); // italicAngle 16.16 fixed
  writer.i16(clampI16(-Math.round(input.unitsPerEm * 0.1)));
  writer.i16(clampI16(Math.max(1, Math.round(input.unitsPerEm * 0.05))));
  writer.u32(0); // isFixedPitch
  writer.u32(0).u32(0).u32(0).u32(0);
  return writer.toUint8Array();
}

function utf16be(value: string): Uint8Array {
  const writer = new ByteWriter();
  for (let i = 0; i < value.length; i++) writer.u16(value.charCodeAt(i));
  return writer.toUint8Array();
}

function buildName(input: TrueTypeFontInput): Uint8Array {
  const meta = input.metadata;
  const entries: Array<[number, string]> = [
    [0, meta.copyright],
    [1, meta.familyName],
    [2, meta.subfamilyName],
    [3, meta.uniqueID],
    [4, meta.fullName],
    [5, `Version ${meta.version}`],
    [6, meta.postScriptName],
    [8, meta.manufacturer],
    [9, meta.creator],
    [13, meta.license],
    [16, meta.familyName],
    [17, meta.subfamilyName],
  ];
  if (meta.description) entries.push([10, meta.description]);
  if (meta.manufacturerURL) entries.push([11, meta.manufacturerURL]);
  if (meta.licenseURL) entries.push([14, meta.licenseURL]);

  const records = entries
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([nameID, value]) => ({ nameID, bytes: utf16be(value) }))
    .sort((a, b) => a.nameID - b.nameID);

  const writer = new ByteWriter();
  const storageOffset = 6 + records.length * 12;
  writer.u16(0); // format
  writer.u16(records.length);
  writer.u16(storageOffset);

  let offset = 0;
  for (const record of records) {
    writer.u16(3); // Windows
    writer.u16(1); // Unicode BMP
    writer.u16(0x0409); // English (United States)
    writer.u16(record.nameID);
    writer.u16(record.bytes.length);
    writer.u16(offset);
    offset += record.bytes.length;
  }
  for (const record of records) writer.raw(record.bytes);

  return writer.toUint8Array();
}

interface CmapEntry {
  cp: number;
  gid: number;
}

function sortedCmapEntries(mapping: Map<number, number>): CmapEntry[] {
  return [...mapping.entries()]
    .map(([cp, gid]) => ({ cp, gid }))
    .filter(({ cp, gid }) => Number.isInteger(cp) && Number.isInteger(gid) && gid > 0)
    .sort((a, b) => a.cp - b.cp);
}

function buildFormat4(entries: CmapEntry[]): Uint8Array {
  const bmp = entries.filter(({ cp }) => cp >= 0 && cp < 0xffff);
  const segments: Array<{ start: number; end: number; delta: number }> = [];

  for (const entry of bmp) {
    const delta = (entry.gid - entry.cp) & 0xffff;
    const prev = segments[segments.length - 1];
    if (prev && entry.cp === prev.end + 1 && delta === prev.delta) {
      prev.end = entry.cp;
    } else {
      segments.push({ start: entry.cp, end: entry.cp, delta });
    }
  }

  // Mandatory sentinel segment.
  segments.push({ start: 0xffff, end: 0xffff, delta: 1 });

  const segCount = segments.length;
  const length = 16 + segCount * 8;
  if (length > 0xffff) {
    throw new Error("Too many irregular BMP cmap segments for TrueType format 4.");
  }

  const writer = new ByteWriter();
  const maxPow2 = 2 ** Math.floor(Math.log2(Math.max(1, segCount)));
  const searchRange = 2 * maxPow2;
  const entrySelector = Math.floor(Math.log2(maxPow2));
  const rangeShift = 2 * segCount - searchRange;

  writer.u16(4);
  writer.u16(length);
  writer.u16(0); // language
  writer.u16(segCount * 2);
  writer.u16(searchRange);
  writer.u16(entrySelector);
  writer.u16(rangeShift);
  for (const segment of segments) writer.u16(segment.end);
  writer.u16(0); // reservedPad
  for (const segment of segments) writer.u16(segment.start);
  for (const segment of segments) writer.u16(segment.delta);
  for (let i = 0; i < segCount; i++) writer.u16(0); // idRangeOffset
  return writer.toUint8Array();
}

function buildFormat12(entries: CmapEntry[]): Uint8Array {
  const groups: Array<{ start: number; end: number; startGid: number }> = [];
  for (const entry of entries) {
    const prev = groups[groups.length - 1];
    if (prev && entry.cp === prev.end + 1 && entry.gid === prev.startGid + (entry.cp - prev.start)) {
      prev.end = entry.cp;
    } else {
      groups.push({ start: entry.cp, end: entry.cp, startGid: entry.gid });
    }
  }

  const length = 16 + groups.length * 12;
  const writer = new ByteWriter();
  writer.u16(12);
  writer.u16(0); // reserved
  writer.u32(length);
  writer.u32(0); // language
  writer.u32(groups.length);
  for (const group of groups) {
    writer.u32(group.start);
    writer.u32(group.end);
    writer.u32(group.startGid);
  }
  return writer.toUint8Array();
}

function buildCmap(mapping: Map<number, number>): Uint8Array {
  const entries = sortedCmapEntries(mapping);
  const format4 = buildFormat4(entries);
  const format12 = buildFormat12(entries);

  const writer = new ByteWriter();
  const headerSize = 4 + 2 * 8;
  const format4Offset = headerSize;
  const format12Offset = format4Offset + format4.length;

  writer.u16(0);
  writer.u16(2);
  writer.u16(3).u16(1).u32(format4Offset);
  writer.u16(3).u16(10).u32(format12Offset);
  writer.raw(format4);
  writer.raw(format12);
  return writer.toUint8Array();
}

function buildOS2(input: TrueTypeFontInput, glyphs: EncodedGlyph[], mapping: Map<number, number>): Uint8Array {
  const writer = new ByteWriter();
  const encoded = [...mapping.keys()].filter((cp) => cp >= 0 && cp <= 0xffff);
  const firstChar = encoded.length ? Math.min(...encoded) : 0;
  const lastChar = encoded.length ? Math.max(...encoded) : 0;
  const avgAdvance = glyphs.length > 1
    ? Math.round(glyphs.slice(1).reduce((sum, glyph) => sum + glyph.advanceWidth, 0) / (glyphs.length - 1))
    : Math.round(input.unitsPerEm * 0.5);

  writer.u16(4); // version
  writer.i16(clampI16(avgAdvance));
  writer.u16(clampU16(input.metadata.weightClass)); // usWeightClass
  writer.u16(5); // usWidthClass
  writer.u16(0); // fsType
  writer.i16(clampI16(Math.round(input.unitsPerEm * 0.65))); // subscript x size
  writer.i16(clampI16(Math.round(input.unitsPerEm * 0.60))); // subscript y size
  writer.i16(0).i16(clampI16(Math.round(input.unitsPerEm * 0.075)));
  writer.i16(clampI16(Math.round(input.unitsPerEm * 0.65))); // superscript x size
  writer.i16(clampI16(Math.round(input.unitsPerEm * 0.60))); // superscript y size
  writer.i16(0).i16(clampI16(Math.round(input.unitsPerEm * 0.35)));
  writer.i16(clampI16(Math.max(1, Math.round(input.unitsPerEm * 0.05))));
  writer.i16(clampI16(Math.round(input.unitsPerEm * 0.25)));
  writer.i16(0); // sFamilyClass
  for (let i = 0; i < 10; i++) writer.u8(0); // panose
  writer.u32(1); // Basic Latin
  writer.u32(0).u32(0).u32(0);
  writer.tag("FSRU");
  writer.u16(clampU16(input.metadata.fsSelection)); // fsSelection: ITALIC/BOLD/REGULAR
  writer.u16(firstChar);
  writer.u16(lastChar);
  writer.i16(clampI16(input.ascender));
  writer.i16(clampI16(input.descender));
  writer.i16(0); // sTypoLineGap
  writer.u16(clampU16(Math.max(0, input.ascender)));
  writer.u16(clampU16(Math.max(0, -input.descender)));
  writer.u32(1); // Latin 1 code page
  writer.u32(0);
  writer.i16(clampI16(input.xHeight));
  writer.i16(clampI16(input.capHeight));
  writer.u16(0); // usDefaultChar (.notdef)
  writer.u16(mapping.has(0x20) ? 0x20 : firstChar);
  writer.u16(2); // usMaxContext
  return writer.toUint8Array();
}

function tableChecksum(data: Uint8Array): number {
  let sum = 0 >>> 0;
  for (let i = 0; i < data.length; i += 4) {
    const value = (
      ((data[i] ?? 0) << 24)
      | ((data[i + 1] ?? 0) << 16)
      | ((data[i + 2] ?? 0) << 8)
      | (data[i + 3] ?? 0)
    ) >>> 0;
    sum = (sum + value) >>> 0;
  }
  return sum >>> 0;
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function writeU32At(bytes: Uint8Array, offset: number, value: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(offset, value >>> 0, false);
}

function assembleSfnt(tables: TableRecord[]): ArrayBuffer {
  const ordered = [...tables].sort((a, b) => a.tag.localeCompare(b.tag));
  const numTables = ordered.length;
  const maxPow2 = 2 ** Math.floor(Math.log2(Math.max(1, numTables)));
  const searchRange = maxPow2 * 16;
  const entrySelector = Math.floor(Math.log2(maxPow2));
  const rangeShift = numTables * 16 - searchRange;

  const directoryLength = 12 + numTables * 16;
  let cursor = directoryLength;
  const records = ordered.map((table) => {
    const offset = cursor;
    cursor += align4(table.data.length);
    return { ...table, offset, checksum: tableChecksum(table.data) };
  });

  const output = new Uint8Array(cursor);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x00010000, false);
  view.setUint16(4, numTables, false);
  view.setUint16(6, searchRange, false);
  view.setUint16(8, entrySelector, false);
  view.setUint16(10, rangeShift, false);

  let headOffset = -1;
  records.forEach((record, index) => {
    const dir = 12 + index * 16;
    for (let i = 0; i < 4; i++) output[dir + i] = record.tag.charCodeAt(i) || 0x20;
    view.setUint32(dir + 4, record.checksum, false);
    view.setUint32(dir + 8, record.offset, false);
    view.setUint32(dir + 12, record.data.length, false);
    output.set(record.data, record.offset);
    if (record.tag === "head") headOffset = record.offset;
  });

  if (headOffset < 0) throw new Error("TrueType writer failed to create the head table.");
  writeU32At(output, headOffset + 8, 0);
  const sum = tableChecksum(output);
  writeU32At(output, headOffset + 8, (SFNT_CHECKSUM_MAGIC - sum) >>> 0);
  return output.buffer;
}

export function buildTrueTypeFont(input: TrueTypeFontInput): TrueTypeFontResult {
  if (!Number.isFinite(input.unitsPerEm) || input.unitsPerEm <= 0) {
    throw new Error("TrueType unitsPerEm is invalid.");
  }
  if (!input.metadata?.familyName?.trim()) {
    throw new Error("TrueType family name is missing.");
  }
  if (!input.metadata?.postScriptName?.trim()) {
    throw new Error("TrueType PostScript name is missing.");
  }

  const built = buildGlyphs(input);
  const tables: TableRecord[] = [
    { tag: "OS/2", data: buildOS2(input, built.glyphs, built.glyphIndexByUnicode) },
    { tag: "cmap", data: buildCmap(built.glyphIndexByUnicode) },
    { tag: "glyf", data: built.glyf },
    { tag: "head", data: buildHead(input, built.globalBBox) },
    { tag: "hhea", data: buildHhea(input, built.glyphs) },
    { tag: "hmtx", data: buildHmtx(built.glyphs) },
    { tag: "loca", data: buildLoca(built.locaOffsets) },
    { tag: "maxp", data: buildMaxp(built.glyphs.length, built.maxPoints, built.maxContours) },
    { tag: "name", data: buildName(input) },
    { tag: "post", data: buildPost(input) },
  ];

  return {
    buffer: assembleSfnt(tables),
    glyphIndexByUnicode: built.glyphIndexByUnicode,
  };
}
