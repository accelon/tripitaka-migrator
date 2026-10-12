// posmap.ts — 位置對照核心：大正藏位置 ⇄ 高麗藏位置（精確到字）
//
// 【原理】兩藏的經文只有插入、刪除、替代三種差異。替代（如「峰/峯」）是一對一的，
// 所以整卷可以拆成一連串 1:1 的對應段（source map 的 mappings）與其間的空隙。
// 只要有這串對應段，加上兩側「每一行的起點字元位移」，就能把一側的字元位移換成
// 另一側的字元位移，再化成「冊/頁/欄/行 + 行內偏置」。客戶端不需要文本。
//
//   T 字元位移 x  ──對應段──▶  K 字元位移 y  ──行表──▶  K 頁欄行 + 行內偏置
//
// 對應段記錄在 posmap.db 的 align 表（BLOB，varint 編碼），或匯出成網頁用的 JSON。
// 本檔為純函式，只依賴 posfmt.ts，Bun 與瀏覽器皆可直接使用。

import {
  Address, Side, formatAddress, parseAddress, packGpos, unpackGpos,
  parsePcl, seqOf, pclOfSeq, formatPcl, ByteWriter, decodeU32,
  bytesToB64, b64ToBytes,
} from "./posfmt";

// ---------------------------------------------------------------- 資料結構

/** 一側（大正藏或高麗藏）某卷的行幾何 */
export interface SideGeom {
  vol: number;
  /** 每行的 seq＝page*1000 + col*100 + line，嚴格遞增 */
  lineSeq: Int32Array;
  /** 每行在該卷漢字序列中的起點；長度 = 行數 + 1（最後一格 = 總漢字數） */
  lineStart: Int32Array;
  nLines: number;
  /** 總漢字數（只數 CJK 表意字符） */
  han: number;
}

/** 一卷的對齊資料（不含經號） */
export interface AlignBody {
  t: SideGeom;
  k: SideGeom;
  /** 正文字元區間 [起, 訖)，T 側 */
  tBody: Int32Array;
  /** 正文字元區間 [起, 訖)，K 側 */
  kBody: Int32Array;
  /** 序文／附文的漢字數（各自座標系；已扣掉正文） */
  tPre: number; tPost: number; kPre: number; kPost: number;
  /** 1:1 對應段，每 3 個 int 為 (tStart, kStart, len) */
  runs: Int32Array;
  /** 對齊粗略（兩邊文字幾乎對不上），轉換結果僅供參考 */
  coarse: boolean;
}

export interface AlignRec extends AlignBody {
  tsutra: string;
  tjuan: number;
  ksutra: string;
  kjuan: number;
}

// ---------------------------------------------------------------- 編碼
//
// BLOB v1 佈局（全部為 varint；gapT/gapK 是相對「上一段結尾」的間隙，恆 ≥ 0）：
//   u8  版本 = 1
//   u8  flags（bit0 = coarse）
//   u32 tVol, tSeq0, tBody0, tBody1, tPre, tPost
//   u32 kVol, kSeq0, kBody0, kBody1, kPre, kPost
//   u32 nRuns；重複 nRuns 次：u32 gapT, u32 gapK, u32 len
//   u32 nTLines；重複：u32 dseq（相對上一行）, u32 han（該行漢字數）
//   u32 nKLines；重複：同上
//
// 每行只需約 2 byte，整庫 1000 萬行約 20 MB；對應段整庫估計 20 萬段，可忽略。

export const POSDB_VERSION = 1;

function writeGeom(w: ByteWriter, g: SideGeom): void {
  w.u32(g.vol);
  w.u32(g.nLines);
  w.u32(g.han);
  let prev = 0;
  for (let i = 0; i < g.nLines; i++) {
    const s = g.lineSeq[i];
    w.u32(s - prev);
    prev = s;
  }
  for (let i = 0; i < g.nLines; i++) {
    w.u32(g.lineStart[i + 1] - g.lineStart[i]);
  }
}

function readGeom(b: Uint8Array, pos: number): { g: SideGeom; pos: number } {
  let r = decodeU32(b, pos); const vol = r.value; pos = r.pos;
  r = decodeU32(b, pos); const n = r.value; pos = r.pos;
  r = decodeU32(b, pos); const han = r.value; pos = r.pos;
  const lineSeq = new Int32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) { r = decodeU32(b, pos); pos = r.pos; prev += r.value; lineSeq[i] = prev; }
  const lineStart = new Int32Array(n + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) { lineStart[i] = acc; r = decodeU32(b, pos); pos = r.pos; acc += r.value; }
  lineStart[n] = acc;
  return { g: { vol, lineSeq, lineStart, nLines: n, han }, pos };
}

export function encodeAlign(a: AlignBody): Uint8Array {
  const w = new ByteWriter(4096);
  w.u8(POSDB_VERSION);
  w.u8(a.coarse ? 1 : 0);
  writeGeom(w, a.t);
  writeGeom(w, a.k);
  w.u32(a.tBody[0]); w.u32(a.tBody[1]); w.u32(a.tPre); w.u32(a.tPost);
  w.u32(a.kBody[0]); w.u32(a.kBody[1]); w.u32(a.kPre); w.u32(a.kPost);
  const nRuns = a.runs.length / 3;
  w.u32(nRuns);
  let pt = 0, pk = 0;
  for (let i = 0; i < nRuns; i++) {
    const t = a.runs[i * 3], k = a.runs[i * 3 + 1], len = a.runs[i * 3 + 2];
    w.u32(t - pt);
    w.u32(k - pk);
    w.u32(len);
    pt = t + len;
    pk = k + len;
  }
  return w.bytes();
}

export function decodeAlign(blob: Uint8Array): AlignBody {
  let pos = 0;
  const ver = blob[pos++];
  if (ver !== POSDB_VERSION) throw new Error(`posmap 資料版本不符：${ver}`);
  const flags = blob[pos++];
  let r = readGeom(blob, pos); const t = r.g; pos = r.pos;
  r = readGeom(blob, pos); const k = r.g; pos = r.pos;
  const num = () => { const x = decodeU32(blob, pos); pos = x.pos; return x.value; };
  const tBody = Int32Array.from([num(), num()]);
  const tPre = num(), tPost = num();
  const kBody = Int32Array.from([num(), num()]);
  const kPre = num(), kPost = num();
  const nRuns = num();
  const runs = new Int32Array(nRuns * 3);
  let pt = 0, pk = 0;
  for (let i = 0; i < nRuns; i++) {
    const t0 = pt + num(), k0 = pk + num(), len = num();
    runs[i * 3] = t0; runs[i * 3 + 1] = k0; runs[i * 3 + 2] = len;
    pt = t0 + len; pk = k0 + len;
  }
  return { t, k, tBody, kBody, tPre, tPost, kPre, kPost, runs, coarse: (flags & 1) !== 0 };
}

// ---------------------------------------------------------------- 行表查詢

/** 找出 seq 所在（或最接近）的行號；回傳 [行索引, 是否精確命中] */
export function findLine(g: SideGeom, seq: number): [number, boolean] {
  const a = g.lineSeq;
  let lo = 0, hi = g.nLines - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] <= seq) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (g.nLines === 0) return [0, false];
  if (a[ans] === seq) return [ans, true];
  // 未命中：取最接近的一行（前一行與後一行比距離）
  if (ans + 1 < g.nLines && Math.abs(a[ans + 1] - seq) < Math.abs(a[ans] - seq)) return [ans + 1, false];
  return [ans, false];
}

/** 找出字元位移 off 落在哪一行（空行會被跳過，落在下一個有字的行） */
export function lineIndexAt(g: SideGeom, off: number): number {
  const s = g.lineStart;
  let lo = 0, hi = g.nLines - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= off) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * 合併首尾相接的對應段。
 *
 * 一段的對照是 k = t + (kStart - tStart)，而一段之內兩側等速前進，所以位移差 d 不變。
 * 若後一段的起點正好是前一段的終點（兩側都沒有空隙），兩段的 d 必然相同，
 * 合起來與分開存**完全等價**——查詢結果一字不差。
 * 純替代（如「峰/峯」）就是這種情形：它不改 d，因此會被併掉；
 * 只有真正的插入／刪除（單邊多出字）才會留下段的邊界。
 * 一卷通常因此從數百段降到個位數段。
 */
export function mergeRunTriples(runs: Int32Array): Int32Array {
  const n = runs.length / 3;
  const out: number[] = [];
  let ts = 0, ks = 0, len = 0;
  for (let i = 0; i < n; i++) {
    const t = runs[i * 3], k = runs[i * 3 + 1], l = runs[i * 3 + 2];
    if (len > 0 && t === ts + len && k === ks + len) { len += l; continue; }
    if (len > 0) out.push(ts, ks, len);
    ts = t; ks = k; len = l;
  }
  if (len > 0) out.push(ts, ks, len);
  return Int32Array.from(out);
}

/** 對應段查詢：回傳 [k 位移, 是否落在對應段內] */
export function mapOffset(runs: Int32Array, tOff: number): [number, boolean] {
  const n = runs.length / 3;
  if (n === 0) return [0, false];
  let lo = 0, hi = n - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid * 3] <= tOff) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans < 0) return [runs[1], false];                    // 落在第一段之前
  const t0 = runs[ans * 3], k0 = runs[ans * 3 + 1], len = runs[ans * 3 + 2];
  if (tOff < t0 + len) return [k0 + (tOff - t0), true];    // 精確對應
  return [k0 + len, false];                                // 落在單邊插文，取最接近的左界
}

/** 對應段反查（K → T） */
export function mapOffsetRev(runs: Int32Array, kOff: number): [number, boolean] {
  const n = runs.length / 3;
  if (n === 0) return [0, false];
  let lo = 0, hi = n - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid * 3 + 1] <= kOff) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (ans < 0) return [runs[0], false];
  const t0 = runs[ans * 3], k0 = runs[ans * 3 + 1], len = runs[ans * 3 + 2];
  if (kOff < k0 + len) return [t0 + (kOff - k0), true];
  return [t0 + len, false];
}

// ---------------------------------------------------------------- 轉換

export type AdjustKind = "none" | "preface" | "appendix" | "nearest-line" | "empty-line" | "reverse";

export interface ConvertResult {
  ok: boolean;
  input: string;
  /** 精確到字的高麗藏位置 */
  koryo: string;
  /** 修正後的大正藏位置（輸入指向序文／附文時會被移到正文邊界） */
  adjustedTaisho: string;
  tPcl: string;
  kPcl: string;
  /** 行內字元偏置 */
  tOff: number;
  kOff: number;
  tGpos: number;
  kGpos: number;
  /** 大正藏經號與卷號 */
  tsutra: string;
  tjuan: number;
  ksutra: string;
  kjuan: number;
  adjust: AdjustKind;
  /** K 側是否落在 1:1 對應段（false 表示指向單邊插文，已取最接近的位置） */
  exact: boolean;
  note: string;
}

function geomAddress(side: Side, g: SideGeom, off: number): Address {
  const li = lineIndexAt(g, off);
  const pcl = pclOfSeq(g.lineSeq[li]);
  return {
    side, vol: g.vol, page: pcl.page, col: pcl.col, line: pcl.line,
    off: Math.max(0, Math.min(off - g.lineStart[li], 999)),
  };
}

/** 由「該側的冊 + pcl + 行內偏置」求出 (行索引, 是否命中 pcl, 全卷字元位移, 調整說明) */
function resolveInput(g: SideGeom, page: number, col: number, line: number, off: number) {
  const pcl = formatPcl({ page, col, line });
  const seq = seqOf({ page, col, line });
  const [li, hit] = findLine(g, seq);
  const lineHan = g.lineStart[li + 1] - g.lineStart[li];
  const o = Math.max(0, Math.min(off, lineHan));
  return { li, hit, pcl, charOff: g.lineStart[li] + o, off: o, lineHan };
}

/** 位移層級的對照結果（位址字串由其上層組出） */
export interface OffsetMap {
  /** 輸入側的字元位移；若被移到正文邊界，這裡是移動後的值 */
  src: number;
  /** 對側的字元位移 */
  dst: number;
  exact: boolean;
  adjust: AdjustKind;
  notes: string[];
}

/** 大正藏字元位移 → 高麗藏字元位移（含序文／附文修正） */
export function mapTOffset(rec: AlignRec, x: number): OffsetMap {
  const notes: string[] = [];
  let adjust: AdjustKind = "none";
  if (x < rec.tBody[0]) { x = rec.tBody[0]; adjust = "preface"; notes.push("輸入落在序文，已移到該卷正文第一字"); }
  else if (x > rec.tBody[1]) { x = rec.tBody[1]; adjust = "appendix"; notes.push("輸入落在附文，已移到該卷正文最後一字的右邊"); }
  let [y, exact] = mapOffset(rec.runs, x);
  if (y < rec.kBody[0]) y = rec.kBody[0];
  if (y > rec.kBody[1]) y = rec.kBody[1];
  if (!exact) notes.push("該處是單邊插文，高麗藏無對應字，已取最接近的位置");
  if (rec.coarse) notes.push("本卷對齊粗略，轉換結果僅供參考");
  return { src: x, dst: y, exact, adjust, notes };
}

/** 高麗藏字元位移 → 大正藏字元位移（附帶功能，同一份對應段反查） */
export function mapKOffset(rec: AlignRec, y: number): OffsetMap {
  const notes: string[] = [];
  let adjust: AdjustKind = "none";
  if (y < rec.kBody[0]) { y = rec.kBody[0]; adjust = "preface"; notes.push("輸入落在序文，已移到該卷正文第一字"); }
  else if (y > rec.kBody[1]) { y = rec.kBody[1]; adjust = "appendix"; notes.push("輸入落在附文，已移到該卷正文最後一字的右邊"); }
  let [x, exact] = mapOffsetRev(rec.runs, y);
  if (x < rec.tBody[0]) x = rec.tBody[0];
  if (x > rec.tBody[1]) x = rec.tBody[1];
  if (!exact) notes.push("該處是單邊插文，大正藏無對應字，已取最接近的位置");
  if (rec.coarse) notes.push("本卷對齊粗略，轉換結果僅供參考");
  return { src: y, dst: x, exact, adjust, notes };
}

function resultOf(
  rec: AlignRec, input: string,
  srcSide: Side, src: SideGeom, dstSide: Side, dst: SideGeom,
  m: OffsetMap, extra: string[],
): ConvertResult {
  const sa = geomAddress(srcSide, src, m.src);
  const da = geomAddress(dstSide, dst, m.dst);
  const ta = srcSide === "T" ? sa : da;
  const ka = srcSide === "K" ? sa : da;
  return {
    ok: true, input,
    koryo: formatAddress(ka),
    adjustedTaisho: formatAddress(ta),
    tPcl: formatPcl({ page: ta.page, col: ta.col, line: ta.line }),
    kPcl: formatPcl({ page: ka.page, col: ka.col, line: ka.line }),
    tOff: ta.off, kOff: ka.off,
    tGpos: packGpos(ta.vol, ta.page, ta.col, ta.line, ta.off),
    kGpos: packGpos(ka.vol, ka.page, ka.col, ka.line, ka.off),
    tsutra: rec.tsutra, tjuan: rec.tjuan, ksutra: rec.ksutra, kjuan: rec.kjuan,
    adjust: m.adjust !== "none" ? m.adjust : (extra.length ? "nearest-line" : "none"),
    exact: m.exact,
    note: [...extra, ...m.notes].join("；"),
  };
}

function failedResult(rec: AlignRec, input: string, note: string): ConvertResult {
  return {
    ok: false, input, koryo: "", adjustedTaisho: "", tPcl: "", kPcl: "",
    tOff: 0, kOff: 0, tGpos: 0, kGpos: 0,
    tsutra: rec.tsutra, tjuan: rec.tjuan, ksutra: rec.ksutra, kjuan: rec.kjuan,
    adjust: "none", exact: false, note,
  };
}

/**
 * convert_taisho_goryeo：輸入大正藏位址，回傳高麗藏位址與修正後的大正藏位址。
 * 輸入指向序文 → 移到該卷正文第一字；指向附文 → 移到該卷正文最後一字的右邊。
 */
export function convertTaishoGoryeo(rec: AlignRec, addr: Address | string): ConvertResult {
  const input = typeof addr === "string" ? addr : formatAddress(addr);
  const a = typeof addr === "string" ? parseAddress(addr) : addr;
  if (!a) return failedResult(rec, input, "位址無法解析");
  if (a.side !== "T") return failedResult(rec, input, "輸入必須是大正藏位址（T 開頭）");
  if (a.vol !== rec.t.vol) return failedResult(rec, input, `冊號不符：輸入第 ${a.vol} 冊，該卷在第 ${rec.t.vol} 冊`);
  if (rec.t.nLines === 0) return failedResult(rec, input, "大正藏該卷沒有資料");

  const inp = resolveInput(rec.t, a.page, a.col, a.line, a.off);
  const extra = inp.hit ? [] : [`大正藏無 ${inp.pcl} 此行，已取最接近的 ${formatPcl(pclOfSeq(rec.t.lineSeq[inp.li]))}`];
  const res = resultOf(rec, input, "T", rec.t, "K", rec.k, mapTOffset(rec, inp.charOff), extra);
  return annotateEmptyLine(res, "T", rec.t, inp.charOff, inp.pcl);
}

/** 反向：高麗藏位址 → 大正藏位址（附帶功能） */
export function convertGoryeoTaisho(rec: AlignRec, addr: Address | string): ConvertResult {
  const input = typeof addr === "string" ? addr : formatAddress(addr);
  const a = typeof addr === "string" ? parseAddress(addr) : addr;
  if (!a) return failedResult(rec, input, "位址無法解析");
  if (a.side !== "K") return failedResult(rec, input, "輸入必須是高麗藏位址（K 開頭）");
  if (a.vol !== rec.k.vol) return failedResult(rec, input, `冊號不符：輸入第 ${a.vol} 冊，該卷在第 ${rec.k.vol} 冊`);
  if (rec.k.nLines === 0) return failedResult(rec, input, "高麗藏該卷沒有資料");

  const inp = resolveInput(rec.k, a.page, a.col, a.line, a.off);
  const extra = inp.hit ? [] : [`高麗藏無 ${inp.pcl} 此行，已取最接近的 ${formatPcl(pclOfSeq(rec.k.lineSeq[inp.li]))}`];
  const res = resultOf(rec, input, "K", rec.k, "T", rec.t, mapKOffset(rec, inp.charOff), extra);
  return annotateEmptyLine(res, "K", rec.k, inp.charOff, inp.pcl);
}

/**
 * 輸入的那一行若整行沒有漢字，指針其實落在下一個有字的行；
 * 位址會因此改變，必須講清楚，不能讓客戶以為位址被無故更動。
 */
function annotateEmptyLine(res: ConvertResult, side: Side, g: SideGeom, charOff: number, inPcl: string): ConvertResult {
  if (!res.ok) return res;
  const landed = formatPcl(pclOfSeq(g.lineSeq[lineIndexAt(g, charOff)]));
  if (landed === inPcl) return res;
  const note = `${side === "T" ? "大正藏" : "高麗藏"} ${inPcl} 整行沒有漢字，指針已移到最近的有字行 ${landed}`;
  return {
    ...res,
    adjust: res.adjust === "none" ? "empty-line" : res.adjust,
    note: res.note ? `${note}；${res.note}` : note,
  };
}

// ---------------------------------------------------------------- 資料來源
//
// 網頁與 CLI 共用同一組介面；CLI 由 posdb.ts 以 bun:sqlite 實作，
// 網頁由 posjson.ts 以 fetch 實作。

export interface AlignSource {
  /** 取某一大正藏卷的對齊資料；找不到回傳 null */
  align(tsutra: string, tjuan: number): AlignRec | null;
}

/** 記憶體中的資料來源（由 JSON 或 SQLite 載入後組裝） */
export function memorySource(recs: Iterable<AlignRec>): AlignSource {
  const m = new Map<string, AlignRec>();
  for (const r of recs) m.set(`${r.tsutra.toUpperCase()}/${r.tjuan}`, r);
  return { align: (s, j) => m.get(`${s.toUpperCase()}/${j}`) ?? null };
}

// ---------------------------------------------------------------- JSON 匯出／載入
//
// 給網頁用的格式（一個經號一個檔）：
//   { "version": 1, "tsutra": "0001", "ksutra": "0647",
//     "juan": { "1": {"tjuan":1,"kjuan":1,"blob":"<base64>"} } }

export interface SutraJson {
  version: number;
  tsutra: string;
  ksutra: string;
  juan: Record<string, { tjuan: number; kjuan: number; blob: string }>;
}

export function recToJsonEntry(rec: AlignRec) {
  return { tjuan: rec.tjuan, kjuan: rec.kjuan, blob: bytesToB64(encodeAlign(rec)) };
}

export function recFromJson(json: SutraJson, tjuan: number): AlignRec | null {
  const e = json.juan[String(tjuan)];
  if (!e) return null;
  return { tsutra: json.tsutra, tjuan: e.tjuan, ksutra: json.ksutra, kjuan: e.kjuan, ...decodeAlign(b64ToBytes(e.blob)) };
}

export function jsonSource(json: SutraJson): AlignSource {
  return {
    align: (s, j) => (s.toUpperCase() === json.tsutra.toUpperCase() ? recFromJson(json, j) : null),
  };
}
