// posfmt.ts — 位置的字串格式、流水號與壓縮編碼
//
// 【位址字串】行業慣例，本模組沿用並作最小擴充：
//
//   T01p0002c0405   大正藏 第 1 冊 第 0002 頁 c 欄 第 04 行 第 05 個字之前
//   K17p0815a0301   高麗藏 第 17 冊 第 0815 頁 a 欄 第 03 行 第 01 個字之前
//   T01p0002c04     偏置為 0 時可省略
//   T49p0024a17.118 偏置 ≥ 100 的長行（全庫僅 6 行，都在大正藏）用點號接三位數
//
//   「第 N 個字之前」＝字串指標：0 在「如」左邊，1 在「如」右邊（＝「是」左邊）。
//   偏置只數 CJK 表意字符，標點、標記、ASCII、IVS 異體字選擇符（U+E0100–E01EF）都不計。
//
// 【壓縮位置 gpos】把 vol/page/col/line/off 塞進一個 TypeScript number
// （十進位排版，便於目視除錯；最大約 2×10^12，遠小於 2^53，可精確表示）：
//
//   gpos = ((((vol * 10000 + page) * 8 + col) * 100 + line) * 1000 + off
//
//   vol  1..        （冊號，不限位數）
//   page 0000..9999 （4 位）
//   col  0..6       （a..g，保留 7）
//   line 01..99     （2 位）
//   off  000..999   （3 位，容納極少數超長行）
//
//   同一冊內 gpos 的大小順序＝閱讀順序，可直接比大小。
//
// 本檔為純函式，不依賴 Bun / Node，瀏覽器可直接使用。

export type Side = "T" | "K";

export const COL_LETTERS = "abcdefg";
/** 每欄的行號上限（實測大正藏最大 92、高麗藏 47） */
export const MAX_LINE = 99;
/** 每行字元偏置上限（實測大正藏最大 190，高麗藏最大 85） */
export const MAX_OFF = 999;

export interface Address {
  side: Side;
  vol: number;
  page: number;
  col: number;
  line: number;
  off: number;
}

const ADDR_RE = /^\s*([KTkt])\s*(\d{1,4})\s*p\s*(\d{1,4})\s*([a-gA-G])\s*(\d{1,4})\s*(?:\.\s*(\d{1,3}))?\s*$/;

/**
 * 解析位址字串。行號固定取前兩位數字，其餘為偏置；
 * 例：c0405 → 行 04、偏置 05；c045 → 行 04、偏置 5；c04 → 行 04、偏置 0；
 *     c04.118 → 行 04、偏置 118。
 */
export function parseAddress(s: string): Address | null {
  const m = ADDR_RE.exec(s);
  if (!m) return null;
  const digits = m[5];
  let line: number, off: number;
  if (m[6] !== undefined) {
    line = Number(digits);
    off = Number(m[6]);
  } else if (digits.length <= 2) {
    line = Number(digits);
    off = 0;
  } else {
    line = Number(digits.slice(0, 2));
    off = Number(digits.slice(2));
  }
  const a: Address = {
    side: m[1].toUpperCase() as Side,
    vol: Number(m[2]),
    page: Number(m[3]),
    col: m[4].toLowerCase().charCodeAt(0) - 97,
    line,
    off,
  };
  if (a.vol < 1 || a.page > 9999 || a.col < 0 || a.col > 6) return null;
  if (a.line < 0 || a.line > MAX_LINE || off < 0 || off > MAX_OFF) return null;
  return a;
}

export interface FormatOptions {
  /** 偏置為 0 時省略（T01p0002c04）。預設 false，一律印滿兩位。 */
  omitZeroOffset?: boolean;
}

export function formatAddress(a: Address, opts: FormatOptions = {}): string {
  const vol = String(a.vol).padStart(2, "0");
  const page = String(a.page).padStart(4, "0");
  const col = COL_LETTERS[a.col] ?? "?";
  const line = String(a.line).padStart(2, "0");
  let tail: string;
  if (a.off >= 100) tail = `${line}.${String(a.off).padStart(3, "0")}`;
  else if (a.off === 0 && opts.omitZeroOffset) tail = line;
  else tail = line + String(a.off).padStart(2, "0");
  return `${a.side}${vol}p${page}${col}${tail}`;
}

// ---------------------------------------------------------------- gpos

export function packGpos(vol: number, page: number, col: number, line: number, off: number): number {
  return ((((vol * 10000 + page) * 8 + col) * 100 + line) * 1000 + off);
}

export function unpackGpos(n: number): { vol: number; page: number; col: number; line: number; off: number } {
  const off = n % 1000; n = (n - off) / 1000;
  const line = n % 100; n = (n - line) / 100;
  const col = n % 8; n = (n - col) / 8;
  const page = n % 10000;
  const vol = (n - page) / 10000;
  return { vol, page, col, line, off };
}

export const gposOfAddress = (a: Address): number => packGpos(a.vol, a.page, a.col, a.line, a.off);

export function addressOfGpos(n: number, side: Side): Address {
  const u = unpackGpos(n);
  return { side, ...u };
}

// ---------------------------------------------------------------- PCL / seq

export interface Pcl { page: number; col: number; line: number }

export function parsePcl(pcl: string): Pcl | null {
  const m = /^(\d{4})([a-gA-G])(\d{2})$/.exec(pcl.trim());
  if (!m) return null;
  return { page: Number(m[1]), col: m[2].toLowerCase().charCodeAt(0) - 97, line: Number(m[3]) };
}

export function formatPcl(p: Pcl): string {
  return String(p.page).padStart(4, "0") + (COL_LETTERS[p.col] ?? "?") + String(p.line).padStart(2, "0");
}

/** 同一冊內可比較大小的流水號：page * 1000 + col * 100 + line */
export const seqOf = (p: Pcl): number => p.page * 1000 + p.col * 100 + p.line;

export function pclOfSeq(seq: number): Pcl {
  const rem = seq % 1000;
  return { page: (seq - rem) / 1000, col: Math.floor(rem / 100), line: rem % 100 };
}

export const seqOfPcl = (pcl: string): number | null => {
  const p = parsePcl(pcl);
  return p ? seqOf(p) : null;
};

// ---------------------------------------------------------------- varint / base64

/** LEB128 無號可變長整數編碼器 */
export class ByteWriter {
  private buf: Uint8Array;
  private len = 0;
  constructor(cap = 1024) { this.buf = new Uint8Array(cap); }
  private need(n: number) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  }
  u8(v: number): void { this.need(1); this.buf[this.len++] = v & 0xff; }
  /** 無號 varint */
  u32(v: number): void {
    this.need(5);
    let x = Math.max(0, Math.floor(v));
    while (x >= 0x80) { this.buf[this.len++] = (x & 0x7f) | 0x80; x = Math.floor(x / 128); }
    this.buf[this.len++] = x;
  }
  /** 有號 varint（zigzag） */
  s32(v: number): void { this.u32(v < 0 ? -2 * v - 1 : 2 * v); }
  bytes(): Uint8Array { return this.buf.slice(0, this.len); }
}

export function decodeU32(b: Uint8Array, pos: number): { value: number; pos: number } {
  let value = 0, shift = 1;
  for (;;) {
    const c = b[pos++];
    value += (c & 0x7f) * shift;
    if ((c & 0x80) === 0) break;
    shift *= 128;
  }
  return { value, pos };
}

export function decodeS32(b: Uint8Array, pos: number): { value: number; pos: number } {
  const r = decodeU32(b, pos);
  const v = r.value;
  return { value: v % 2 === 0 ? v / 2 : -(v + 1) / 2, pos: r.pos };
}

const _btoa = (globalThis as any).btoa as ((s: string) => string) | undefined;
const _atob = (globalThis as any).atob as ((s: string) => string) | undefined;

export function bytesToB64(b: Uint8Array): string {
  if (!_btoa) throw new Error("此環境沒有 btoa");
  let s = "";
  for (let i = 0; i < b.length; i += 8192) {
    s += String.fromCharCode(...b.subarray(i, i + 8192));
  }
  return _btoa(s);
}

export function b64ToBytes(s: string): Uint8Array {
  if (!_atob) throw new Error("此環境沒有 atob");
  const bin = _atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
