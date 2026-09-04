/**
 * WHEEL - QRCodeGen
 *
 * A self-contained QR encoder: byte mode, error correction level L, versions
 * 5 to 10. Pure logic - no Lens API, no packages, no external library - so the
 * matrix can be generated and eyeballed in plain Node before it ever reaches a
 * texture.
 *
 * This output gets pointed at a phone camera, so "roughly right" is worthless:
 * a symbol that is one module wrong simply does not scan and the failure looks
 * identical to a rendering bug. Everything below follows ISO/IEC 18004 rather
 * than being tuned by eye - in particular the alignment-pattern centres, the
 * 0x5412 format mask, the 0x1F25 version BCH (mandatory from version 7 up),
 * and the skipped vertical timing column during data placement.
 *
 * Level L is deliberate: the payload is a fixed 47-character base64url share
 * code, the panel is large and well lit, and L buys the smallest module count,
 * which is what actually decides whether a waveguide panel is scannable.
 */

/** Error-correction level L, as the two bits used in the format information. */
export const ECL_FORMAT_BITS = 0x01;

/** Byte mode indicator. */
export const MODE_BYTE = 0x04;

/** Pad codewords, alternated after the terminator. */
export const PAD_CODEWORDS = [0xec, 0x11];

/** GF(256) primitive polynomial used by QR: x^8 + x^4 + x^3 + x^2 + 1. */
export const GF_PRIMITIVE = 0x11d;

/** Format information BCH(15,5) generator and its mandatory output mask. */
export const FORMAT_GENERATOR = 0x537;
export const FORMAT_MASK = 0x5412;

/** Version information BCH(18,6) generator, used from version 7 up. */
export const VERSION_GENERATOR = 0x1f25;

/** Mask penalty weights from the spec. Do not tune. */
export const PENALTY_N1 = 3;
export const PENALTY_N2 = 3;
export const PENALTY_N3 = 40;
export const PENALTY_N4 = 10;

export const MIN_VERSION = 5;
export const MAX_VERSION = 10;

export interface QRVersionSpec {
  version: number;
  /** Modules per side: 17 + 4 * version. */
  size: number;
  /** Data + EC codewords the symbol holds. */
  totalCodewords: number;
  /** EC codewords per block (identical across both groups at every version). */
  ecPerBlock: number;
  group1Blocks: number;
  group1DataCodewords: number;
  group2Blocks: number;
  group2DataCodewords: number;
  /** Data codewords available to the bit stream, header included. */
  dataCodewords: number;
  /** Payload bytes that fit once mode + character-count + terminator are paid for. */
  byteCapacity: number;
  /** Alignment pattern centre coordinates (row == column set). */
  alignmentCenters: number[];
  /** Unused modules left light after the last codeword. */
  remainderBits: number;
}

/**
 * Block structure and capacity, error correction level L, versions 5..10.
 *
 * Auditable on purpose: every one of these numbers comes from ISO/IEC 18004
 * tables 9 and 13-22, and a single transcription slip here produces a symbol
 * that looks perfect and scans as nothing. Sanity check: for each row,
 * group1Blocks * group1DataCodewords + group2Blocks * group2DataCodewords
 * + (group1Blocks + group2Blocks) * ecPerBlock == totalCodewords.
 */
export const QR_VERSION_TABLE: QRVersionSpec[] = [
  {
    version: 5,
    size: 37,
    totalCodewords: 134,
    ecPerBlock: 26,
    group1Blocks: 1,
    group1DataCodewords: 108,
    group2Blocks: 0,
    group2DataCodewords: 0,
    dataCodewords: 108,
    byteCapacity: 106,
    alignmentCenters: [6, 30],
    remainderBits: 7
  },
  {
    version: 6,
    size: 41,
    totalCodewords: 172,
    ecPerBlock: 18,
    group1Blocks: 2,
    group1DataCodewords: 68,
    group2Blocks: 0,
    group2DataCodewords: 0,
    dataCodewords: 136,
    byteCapacity: 134,
    alignmentCenters: [6, 34],
    remainderBits: 7
  },
  {
    version: 7,
    size: 45,
    totalCodewords: 196,
    ecPerBlock: 20,
    group1Blocks: 2,
    group1DataCodewords: 78,
    group2Blocks: 0,
    group2DataCodewords: 0,
    dataCodewords: 156,
    byteCapacity: 154,
    alignmentCenters: [6, 22, 38],
    remainderBits: 0
  },
  {
    version: 8,
    size: 49,
    totalCodewords: 242,
    ecPerBlock: 24,
    group1Blocks: 2,
    group1DataCodewords: 97,
    group2Blocks: 0,
    group2DataCodewords: 0,
    dataCodewords: 194,
    byteCapacity: 192,
    alignmentCenters: [6, 24, 42],
    remainderBits: 0
  },
  {
    version: 9,
    size: 53,
    totalCodewords: 292,
    ecPerBlock: 30,
    group1Blocks: 2,
    group1DataCodewords: 116,
    group2Blocks: 0,
    group2DataCodewords: 0,
    dataCodewords: 232,
    byteCapacity: 230,
    alignmentCenters: [6, 26, 46],
    remainderBits: 0
  },
  {
    version: 10,
    size: 57,
    totalCodewords: 346,
    ecPerBlock: 18,
    group1Blocks: 2,
    group1DataCodewords: 68,
    group2Blocks: 2,
    group2DataCodewords: 69,
    dataCodewords: 274,
    // Version 10 and up spends 16 bits on the character count, not 8, which is
    // why the capacity drops relative to the extra data codewords.
    byteCapacity: 271,
    alignmentCenters: [6, 28, 50],
    remainderBits: 0
  }
];

function specFor(version: number): QRVersionSpec | null {
  for (let i = 0; i < QR_VERSION_TABLE.length; i++) {
    if (QR_VERSION_TABLE[i].version === version) {
      return QR_VERSION_TABLE[i];
    }
  }
  return null;
}

/** Character-count field width for byte mode: 8 bits below version 10, else 16. */
function charCountBits(version: number): number {
  return version < 10 ? 8 : 16;
}

/* ------------------------------------------------------------------ *
 * GF(256) arithmetic.
 * ------------------------------------------------------------------ */

const GF_EXP: number[] = new Array(512);
const GF_LOG: number[] = new Array(256);

(function initGaloisTables(): void {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= GF_PRIMITIVE;
    }
  }
  // Doubled table so a log sum up to 508 needs no modulo in the hot path.
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
  GF_LOG[0] = 0; // never read; zero is special-cased in gfMul
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * Coefficients of the Reed-Solomon divisor polynomial of the given degree,
 * (x - 2^0)(x - 2^1)...(x - 2^(degree-1)), leading 1 omitted.
 */
function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) {
        result[j] ^= result[j + 1];
      }
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** The EC codewords for one block: the remainder of data * x^degree over the divisor. */
function rsRemainder(data: number[], divisor: number[]): number[] {
  const result: number[] = new Array(divisor.length).fill(0);
  for (let i = 0; i < data.length; i++) {
    const factor = (data[i] ^ result.shift()) & 0xff;
    result.push(0);
    for (let j = 0; j < divisor.length; j++) {
      result[j] ^= gfMul(divisor[j], factor);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Bit stream and codeword assembly.
 * ------------------------------------------------------------------ */

class BitBuffer {
  bits: number[] = [];

  append(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.bits.push((value >>> i) & 1);
    }
  }
}

/**
 * UTF-8 bytes. QR byte mode is nominally ISO-8859-1, but every phone scanner
 * in circulation decodes UTF-8, and the share payload is ASCII anyway - this
 * only matters if someone ever passes a non-ASCII URL.
 */
export function toUtf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.charCodeAt(i);
    // Recombine surrogate pairs so astral characters encode as one code point.
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < text.length) {
      const lo = text.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >>> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >>> 12), 0x80 | ((cp >>> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >>> 18),
        0x80 | ((cp >>> 12) & 0x3f),
        0x80 | ((cp >>> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
    }
  }
  return out;
}

/** Mode indicator + count + payload + terminator + pad, to exactly dataCodewords. */
function buildDataCodewords(bytes: number[], spec: QRVersionSpec): number[] {
  const bb = new BitBuffer();
  bb.append(MODE_BYTE, 4);
  bb.append(bytes.length, charCountBits(spec.version));
  for (let i = 0; i < bytes.length; i++) {
    bb.append(bytes[i] & 0xff, 8);
  }

  const capacityBits = spec.dataCodewords * 8;
  // Terminator: up to four zero bits, truncated if the symbol is nearly full.
  const terminator = Math.min(4, capacityBits - bb.bits.length);
  bb.append(0, terminator);
  // Then zeros to the next codeword boundary.
  bb.append(0, (8 - (bb.bits.length % 8)) % 8);

  const codewords: number[] = [];
  for (let i = 0; i < bb.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) {
      byte = (byte << 1) | bb.bits[i + j];
    }
    codewords.push(byte);
  }
  for (let i = 0; codewords.length < spec.dataCodewords; i++) {
    codewords.push(PAD_CODEWORDS[i % PAD_CODEWORDS.length]);
  }
  return codewords;
}

/**
 * Split into blocks, compute EC per block, then interleave data codewords
 * column-wise followed by interleaved EC codewords. Interleaving is what makes
 * a burst of damage spread thinly across blocks instead of destroying one.
 */
function interleaveBlocks(dataCodewords: number[], spec: QRVersionSpec): number[] {
  const divisor = rsDivisor(spec.ecPerBlock);
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];

  let offset = 0;
  const push = (count: number, length: number): void => {
    for (let b = 0; b < count; b++) {
      const block = dataCodewords.slice(offset, offset + length);
      offset += length;
      blocks.push(block);
      ecBlocks.push(rsRemainder(block, divisor));
    }
  };
  push(spec.group1Blocks, spec.group1DataCodewords);
  push(spec.group2Blocks, spec.group2DataCodewords);

  const maxData = Math.max(spec.group1DataCodewords, spec.group2DataCodewords);
  const out: number[] = [];
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < blocks[b].length) {
        out.push(blocks[b][i]);
      }
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (let b = 0; b < ecBlocks.length; b++) {
      out.push(ecBlocks[b][i]);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Matrix construction.
 *
 * modules[y][x]; y counts down from the top row, x rightward from the left,
 * matching how the symbol is printed and how matrixToAscii renders it.
 * ------------------------------------------------------------------ */

class Symbol2D {
  readonly size: number;
  readonly modules: boolean[][];
  /** True where a function pattern lives; data placement and masking skip these. */
  readonly isFunction: boolean[][];

  constructor(size: number) {
    this.size = size;
    this.modules = [];
    this.isFunction = [];
    for (let y = 0; y < size; y++) {
      this.modules.push(new Array(size).fill(false));
      this.isFunction.push(new Array(size).fill(false));
    }
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && x < this.size && y >= 0 && y < this.size;
  }

  setFunction(x: number, y: number, dark: boolean): void {
    if (!this.inBounds(x, y)) {
      return;
    }
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }
}

/** Finder plus its separator in one sweep: the 5x5 ring test also blanks the border. */
function drawFinder(sym: Symbol2D, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      sym.setFunction(cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(sym: Symbol2D, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      sym.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFunctionPatterns(sym: Symbol2D, spec: QRVersionSpec): void {
  const size = sym.size;

  // Timing patterns first; finders and alignment overwrite where they overlap.
  for (let i = 0; i < size; i++) {
    sym.setFunction(6, i, i % 2 === 0);
    sym.setFunction(i, 6, i % 2 === 0);
  }

  drawFinder(sym, 3, 3);
  drawFinder(sym, size - 4, 3);
  drawFinder(sym, 3, size - 4);

  // Alignment patterns at every centre pair except the three that would sit on
  // a finder pattern (the corners of the centre grid).
  const c = spec.alignmentCenters;
  const last = c.length - 1;
  for (let i = 0; i < c.length; i++) {
    for (let j = 0; j < c.length; j++) {
      const skip =
        (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (!skip) {
        drawAlignment(sym, c[j], c[i]);
      }
    }
  }

  // Reserve the two format-information strips (and the fixed dark module) by
  // writing a placeholder mask-0 format. Reserving by hand would be a second
  // copy of the placement mapping, and the two must never diverge: the strips
  // step OVER the timing modules at (8,6) and (6,8), so a naive rectangular
  // reservation silently blanks two timing modules. The real values are
  // rewritten once the mask is chosen.
  drawFormatInfo(sym, 0);

  if (spec.version >= 7) {
    drawVersionInfo(sym, spec.version);
  }
}

/** 18-bit version information, BCH(18,6), mandatory from version 7. */
function drawVersionInfo(sym: Symbol2D, version: number): void {
  let rem = version;
  for (let i = 0; i < 12; i++) {
    rem = ((rem << 1) ^ (((rem >>> 11) & 1) * VERSION_GENERATOR)) & 0xfff;
  }
  const bits = ((version << 12) | rem) >>> 0;
  const size = sym.size;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    sym.setFunction(a, b, dark); // top-right block
    sym.setFunction(b, a, dark); // bottom-left block, transposed
  }
}

/** 15-bit format information for the chosen mask, BCH(15,5) then XOR 0x5412. */
function drawFormatInfo(sym: Symbol2D, mask: number): void {
  const data = (ECL_FORMAT_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) {
    rem = ((rem << 1) ^ (((rem >>> 9) & 1) * FORMAT_GENERATOR)) & 0x3ff;
  }
  // The XOR is what stops an all-light symbol from producing all-light format
  // bits, which no decoder could lock onto.
  const bits = (((data << 10) | rem) ^ FORMAT_MASK) & 0x7fff;
  const size = sym.size;
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;

  // First copy, wrapped around the top-left finder.
  for (let i = 0; i <= 5; i++) {
    sym.setFunction(8, i, bit(i));
  }
  sym.setFunction(8, 7, bit(6));
  sym.setFunction(8, 8, bit(7));
  sym.setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i++) {
    sym.setFunction(14 - i, 8, bit(i));
  }

  // Second copy, split between the top-right and bottom-left finders.
  for (let i = 0; i < 8; i++) {
    sym.setFunction(size - 1 - i, 8, bit(i));
  }
  for (let i = 8; i < 15; i++) {
    sym.setFunction(8, size - 15 + i, bit(i));
  }
  sym.setFunction(8, size - 8, true);
}

/**
 * Zig-zag placement, two modules wide, alternating upward and downward, right
 * to left. The vertical timing column (x == 6) is skipped entirely rather than
 * stepped over, which shifts every column to its left by one - getting this
 * wrong misplaces the whole payload while still looking like a plausible QR.
 */
function drawCodewords(sym: Symbol2D, codewords: number[]): void {
  const size = sym.size;
  let i = 0;
  const totalBits = codewords.length * 8;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!sym.isFunction[y][x] && i < totalBits) {
          sym.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
        // Remainder bits beyond the last codeword stay light, per the spec.
      }
    }
  }
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function applyMask(sym: Symbol2D, mask: number): void {
  for (let y = 0; y < sym.size; y++) {
    for (let x = 0; x < sym.size; x++) {
      if (!sym.isFunction[y][x] && maskBit(mask, x, y)) {
        sym.modules[y][x] = !sym.modules[y][x];
      }
    }
  }
}

/** The finder-lookalike sequence penalised by rule 3, and its mirror. */
const FINDER_RUN = [true, false, true, true, true, false, true];

/** Read with light padding outside the symbol; rule 3 counts a light quiet zone. */
function lineAt(sym: Symbol2D, horizontal: boolean, line: number, i: number): boolean {
  if (i < 0 || i >= sym.size) {
    return false;
  }
  return horizontal ? sym.modules[line][i] : sym.modules[i][line];
}

function finderPenaltyAt(sym: Symbol2D, horizontal: boolean, line: number, start: number): number {
  // 1:1:3:1:1 core preceded OR followed by four light modules.
  for (let k = 0; k < FINDER_RUN.length; k++) {
    if (lineAt(sym, horizontal, line, start + k) !== FINDER_RUN[k]) {
      return 0;
    }
  }
  let before = true;
  for (let k = 1; k <= 4; k++) {
    if (lineAt(sym, horizontal, line, start - k)) {
      before = false;
      break;
    }
  }
  let after = true;
  for (let k = 0; k < 4; k++) {
    if (lineAt(sym, horizontal, line, start + FINDER_RUN.length + k)) {
      after = false;
      break;
    }
  }
  return before || after ? PENALTY_N3 : 0;
}

/** The four spec penalty rules. Lower is better; used only to choose a mask. */
function maskPenalty(sym: Symbol2D): number {
  const size = sym.size;
  let penalty = 0;

  // Rule 1: runs of five or more same-coloured modules in a row or column.
  for (let pass = 0; pass < 2; pass++) {
    const horizontal = pass === 0;
    for (let line = 0; line < size; line++) {
      let runColor = lineAt(sym, horizontal, line, 0);
      let runLength = 1;
      for (let i = 1; i < size; i++) {
        const c = lineAt(sym, horizontal, line, i);
        if (c === runColor) {
          runLength++;
        } else {
          if (runLength >= 5) {
            penalty += PENALTY_N1 + (runLength - 5);
          }
          runColor = c;
          runLength = 1;
        }
      }
      if (runLength >= 5) {
        penalty += PENALTY_N1 + (runLength - 5);
      }
    }
  }

  // Rule 2: every 2x2 block of one colour.
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = sym.modules[y][x];
      if (
        c === sym.modules[y][x + 1] &&
        c === sym.modules[y + 1][x] &&
        c === sym.modules[y + 1][x + 1]
      ) {
        penalty += PENALTY_N2;
      }
    }
  }

  // Rule 3: finder-lookalike patterns, which would confuse locator search.
  for (let pass = 0; pass < 2; pass++) {
    const horizontal = pass === 0;
    for (let line = 0; line < size; line++) {
      for (let start = -4; start + FINDER_RUN.length <= size + 4; start++) {
        penalty += finderPenaltyAt(sym, horizontal, line, start);
      }
    }
  }

  // Rule 4: deviation of the dark-module proportion from 50%.
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (sym.modules[y][x]) {
        dark++;
      }
    }
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  penalty += k * PENALTY_N4;

  return penalty;
}

/* ------------------------------------------------------------------ *
 * Public API.
 * ------------------------------------------------------------------ */

/**
 * Encode text as a QR symbol. Returns modules[y][x], true == dark.
 * Side length is 17 + 4 * version.
 *
 * Steps up through the version table until the payload fits, then throws with
 * the measured overflow if even version 10 is too small - the caller is
 * expected to catch that and fall back to plain text.
 */
export function generateQR(text: string, minVersion: number = MIN_VERSION): boolean[][] {
  const bytes = toUtf8Bytes(typeof text === "string" ? text : String(text));
  const start = Math.max(MIN_VERSION, Math.min(MAX_VERSION, Math.floor(minVersion) || MIN_VERSION));

  let spec: QRVersionSpec = null;
  for (let v = start; v <= MAX_VERSION; v++) {
    const candidate = specFor(v);
    if (candidate && bytes.length <= candidate.byteCapacity) {
      spec = candidate;
      break;
    }
  }
  if (spec === null) {
    const largest = specFor(MAX_VERSION);
    throw new Error(
      "QRCodeGen: payload of " +
        bytes.length +
        " bytes exceeds the version " +
        MAX_VERSION +
        " level-L byte capacity of " +
        largest.byteCapacity +
        " bytes."
    );
  }

  const codewords = interleaveBlocks(buildDataCodewords(bytes, spec), spec);

  // One masked candidate per pattern; the lowest penalty wins. The unmasked
  // symbol is rebuilt each time because masking is an in-place XOR.
  let best: Symbol2D = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const sym = new Symbol2D(spec.size);
    drawFunctionPatterns(sym, spec);
    drawCodewords(sym, codewords);
    applyMask(sym, mask);
    drawFormatInfo(sym, mask);
    const penalty = maskPenalty(sym);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      best = sym;
    }
  }

  return best.modules;
}

/**
 * Render a matrix for the Logger. Two characters per module so the symbol is
 * roughly square in a monospace log - a one-character-wide render is squashed
 * to half width and hides placement errors.
 */
export function matrixToAscii(m: boolean[][], quietZone: number = 4): string {
  if (!m || m.length === 0) {
    return "";
  }
  const q = Math.max(0, Math.floor(quietZone));
  const size = m.length;
  const width = size + q * 2;
  const blankRow = "  ".repeat(width);
  const lines: string[] = [];

  for (let i = 0; i < q; i++) {
    lines.push(blankRow);
  }
  for (let y = 0; y < size; y++) {
    let line = "  ".repeat(q);
    for (let x = 0; x < size; x++) {
      line += m[y][x] ? "██" : "  ";
    }
    line += "  ".repeat(q);
    lines.push(line);
  }
  for (let i = 0; i < q; i++) {
    lines.push(blankRow);
  }
  return lines.join("\n");
}
