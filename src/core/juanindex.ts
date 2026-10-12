// juanindex.ts — 高麗藏(K.db) / 大正藏(T.db) 的卷索引與對照表解析
//
// 【重要】舊版 K.db 的 juan.vol 與 lines.vol 是兩套不同的分冊方式，直接照 juan.vol
// 取文會取到別部經的內容（例如 K0001 的卷 1-300 全記成 vol=1，實際分佈在 lines 的
// vol 1 與 vol 2；K0002 記成 vol=4，實際在 vol=5）。這已由 makejuaninfo.ts 修正
// k-txt/juaninfo.tsv 的冊號、再用 packdb.ts 重新打包解決。本模組因此直接讀取 juan 表，
// 不再重建冊號，只做一次「卷範圍是否有資料」的檢查。
//
// 另：juan 表新增 4 欄（由 juaninfo.tsv 帶入），供「只讀正文」使用：
//   preface_lines  卷首屬於序言的行數（正文從其後開始）
//   appendix_lines 卷末屬於附文的行數（正文到其前結束）
//   preface_chars  序言漢字數
//   appendix_chars 附文漢字數

import { Database } from "bun:sqlite";
import { readFileSync } from "fs";

/** 漢字（含擴充 A/B 區、相容區）。標點、標記、數字、ASCII 一律排除。 */
export const HAN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ffff}]/gu;
export const hanOnly = (s: string): string => s.match(HAN_RE)?.join("") ?? "";
export const hanCount = (s: string): number => s.match(HAN_RE)?.length ?? 0;

export interface JuanRec {
  sutra: string;
  juan: number;
  /** 所屬冊號（lines.vol） */
  vol: number;
  /** juaninfo 原記載的冊號；修正後與 vol 相同，保留供追溯 */
  juanVol: number;
  start_seq: number;
  end_seq: number;
  start_pcl: string;
  end_pcl: string;
  name: string;
  total_lines: number | null;
  preface_lines: number | null;
  appendix_lines: number | null;
  preface_chars: number | null;
  appendix_chars: number | null;
}

export interface SutraIndex {
  sutra: string;
  juanCount: number;
  juan: JuanRec[];
  /** 該經跨了幾冊 */
  vols: number[];
}

// ---------------------------------------------------------------- 資料庫

export function openDb(path: string): Database {
  return new Database(path, { readonly: true });
}

/** 正規化經號：數字補足 4 位，保留字母後綴；比較時一律大寫。 */
export function normSutra(s: string): string {
  const t = s.trim();
  const m = /^(\d+)([A-Za-z]?)$/.exec(t);
  return m ? m[1].padStart(4, "0") + m[2].toUpperCase() : t.toUpperCase();
}

// ---------------------------------------------------------------- 卷索引

interface RawJuan {
  sutra: string; vol: number; juan: number; name: string;
  start_pcl: string; end_pcl: string; start_seq: number; end_seq: number;
  total_lines: number | null;
  preface_lines: number | null; appendix_lines: number | null;
  preface_chars: number | null; appendix_chars: number | null;
}

/** 直接讀取 juan 表建立索引（key 一律大寫經號） */
function loadIndex(db: Database): Map<string, SutraIndex> {
  const raw = db.query(`
    SELECT sutra, vol, juan, name, start_pcl, end_pcl, start_seq, end_seq, total_lines,
           preface_lines, appendix_lines, preface_chars, appendix_chars
    FROM juan ORDER BY sutra, juan
  `).all() as RawJuan[];

  const grouped = new Map<string, RawJuan[]>();
  for (const r of raw) {
    const k = r.sutra.toUpperCase();
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k)!.push(r);
  }

  const out = new Map<string, SutraIndex>();
  for (const [k, rs] of grouped) {
    const juan: JuanRec[] = rs.map(r => ({
      sutra: r.sutra, juan: r.juan, vol: r.vol, juanVol: r.vol,
      start_seq: r.start_seq, end_seq: r.end_seq,
      start_pcl: r.start_pcl, end_pcl: r.end_pcl, name: r.name,
      total_lines: r.total_lines,
      preface_lines: r.preface_lines, appendix_lines: r.appendix_lines,
      preface_chars: r.preface_chars, appendix_chars: r.appendix_chars,
    }));
    out.set(k, { sutra: rs[0].sutra, juanCount: juan.length, juan, vols: [...new Set(juan.map(j => j.vol))] });
  }
  return out;
}

/**
 * 高麗藏卷索引。除了讀取，另檢查每卷範圍在其冊中是否有資料；
 * 若大量落空，通常代表用到的是未修正冊號的舊 K.db。
 */
export function buildGoryeoIndex(kdb: Database, onWarn?: (msg: string) => void): Map<string, SutraIndex> {
  const out = loadIndex(kdb);
  const bad = (kdb.query(`
    SELECT COUNT(*) n FROM juan j WHERE NOT EXISTS (
      SELECT 1 FROM lines l WHERE l.vol = j.vol AND l.seq >= j.start_seq AND l.seq <= j.end_seq)
  `).get() as { n: number }).n;
  const total = [...out.values()].reduce((a, e) => a + e.juanCount, 0);
  onWarn?.(`K 卷索引：${out.size} 部 / ${total} 卷；範圍無資料 ${bad} 卷`);
  if (bad > 0) {
    onWarn?.(`警告：有 ${bad} 卷的範圍在 juan.vol 所指的冊中沒有資料。` +
      `若用的是修正前的舊 K.db，請以 makejuaninfo.ts + packdb.ts 重新打包後再用。`);
  }
  return out;
}

export function buildTaishoIndex(tdb: Database): Map<string, SutraIndex> {
  return loadIndex(tdb);
}

// ---------------------------------------------------------------- 對照表

export type MapKind = "exact" | "partial" | "multi" | "none";

export interface TaishoMapping {
  kind: MapKind;
  /** 直接對應時的大正經號（partial 時含 -k9 之類的分段後綴） */
  raw?: string;
  /** 用於查 T.db 的經號（partial 時為主經號） */
  target?: string;
  /** multi 時的數個大正經號 */
  parts?: string[];
  note?: string;
}

/**
 * 由 goryeo2taisho.json（高麗經號 -> 大正經號）建立對照。
 * 特殊值說明：
 *   "0220-k9"、"0397-p16"、"1452-s2"、"1440-j9"、"2128-j21~j23"
 *     表示高麗的一卷只對應大正某部大經的一個局部（如 T0220 大般若經的第九會），
 *     卷數無法直接比較。
 *   鍵 "0438-s1"、"1224-s01" 等表示高麗把數部小經合刊成一卷。
 */
export function loadMapping(path = "goryeo2taisho.json"): Map<string, TaishoMapping> {
  const raw: Record<string, string> = JSON.parse(readFileSync(path, "utf-8"));
  const direct = new Map<string, string>();
  const grouped = new Map<string, string[]>();
  for (const [k, v] of Object.entries(raw)) {
    const key = normSutra(k);
    const m = /^(\d+[A-Za-z]?)-s(\d+)$/.exec(k.trim());
    if (m) {
      const base = normSutra(m[1]);
      if (!grouped.has(base)) grouped.set(base, []);
      grouped.get(base)!.push(v);
    } else {
      direct.set(key, v);
    }
  }
  const out = new Map<string, TaishoMapping>();
  for (const [k, v] of direct) {
    if (v.includes("-")) {
      const base = normSutra(v.split("-")[0]);
      out.set(k, { kind: "partial", raw: v, target: base, note: "高麗卷只對應大正該經的局部" });
    } else {
      out.set(k, { kind: "exact", raw: v, target: normSutra(v) });
    }
  }
  for (const [k, parts] of grouped) {
    out.set(k, { kind: "multi", raw: parts.join(","), parts: parts.map(normSutra), note: "高麗合刊，對應多部大正經" });
  }
  return out;
}

// ---------------------------------------------------------------- 取卷經文

export interface JuanText {
  juan: JuanRec;
  /** 每行（含空行，順序與 DB 內一致） */
  lines: { pcl: string; text: string }[];
  /** 串接後的漢字序列 */
  hanzi: string;
  /** 每個漢字在 lines 中的索引，用於把字元位移換算回 pcl */
  lineOfChar: Uint16Array;
}

export interface ReadOptions {
  /** 只取正文：跳過卷首 preface_lines 行，去掉卷末 appendix_lines 行 */
  bodyOnly?: boolean;
}

export function readJuan(db: Database, rec: JuanRec, opts: ReadOptions = {}): JuanText {
  const rows = db.query(`
    SELECT pcl, text FROM lines
    WHERE vol = ? AND seq >= ? AND seq <= ?
    ORDER BY seq
  `).all(rec.vol, rec.start_seq, rec.end_seq) as { pcl: string; text: string }[];

  let from = 0, to = rows.length;
  if (opts.bodyOnly) {
    from = Math.min(Math.max(rec.preface_lines ?? 0, 0), rows.length);
    to = Math.max(from, rows.length - Math.max(rec.appendix_lines ?? 0, 0));
  }

  const lines: { pcl: string; text: string }[] = [];
  const chars: string[] = [];
  const owner: number[] = [];
  for (let i = from; i < to; i++) {
    const r = rows[i];
    const h = hanOnly(r.text ?? "");
    const idx = lines.length;
    lines.push(r);                     // 空行也保留，行序才與 DB 內一致（行數欄位要用）
    for (const ch of h) { chars.push(ch); owner.push(idx); }
  }
  return { juan: rec, lines, hanzi: chars.join(""), lineOfChar: Uint16Array.from(owner) };
}

/** 把漢字位移換算成 pcl（用於輸出正文起點） */
export function pclAt(t: JuanText, offset: number): string {
  if (t.lines.length === 0) return "";
  const o = Math.max(0, Math.min(offset, t.lineOfChar.length - 1));
  const li = t.lineOfChar.length ? t.lineOfChar[o] : 0;
  return t.lines[li]?.pcl ?? t.lines[0].pcl;
}

// ---------------------------------------------------------------- 卷界偵測

/** 漢字數字轉整數（支援「四百五十一」這類寫法） */
export function cnNumeralToInt(s: string): number {
  const d: Record<string, number> = { "〇": 0, "○": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
  const u: Record<string, number> = { "十": 10, "百": 100, "千": 1000 };
  let section = 0, num = 0;
  for (const ch of s) {
    if (ch in d) { num = d[ch]; }
    else if (ch in u) { section += (num === 0 ? 1 : num) * u[ch]; num = 0; }
    else return 0;
  }
  return section + num;
}

/** 整數轉漢字數字（與 cnNumeralToInt 互逆，涵蓋 1..999） */
export function intToCnNumeral(n: number): string {
  const d = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  if (n <= 0 || n > 999) return String(n);
  let s = "";
  const h = Math.floor(n / 100), r = n % 100, t = Math.floor(r / 10), o = r % 10;
  if (h) s += d[h] + "百" + (r && t === 0 ? "零" : "");
  if (t) s += (t === 1 && !h ? "" : d[t]) + "十";
  if (o) s += d[o];
  return s;
}

/** 一行若是「某某經卷第X」形式的卷首標題，回傳其卷號，否則 0 */
const HDR_RE = /^(.{2,24}?)卷第?([一二三四五六七八九十百千〇○零]+)$/;

/**
 * 找出「卷範圍內出現別的卷的卷首標題」的情形。
 * 這代表該資料庫的 juan 分卷界線與刻本實際分卷不一致（K.db 1 卷、T.db 180 卷）。
 * 回傳 key = `${經號}/${卷號}`，value = 說明。
 */
export function detectBoundaryIssues(db: Database, idx: Map<string, SutraIndex>): Map<string, string> {
  const out = new Map<string, string>();
  const stmt = db.prepare(
    "SELECT text FROM lines WHERE vol = ? AND seq >= ? AND seq <= ? AND text LIKE '%卷第%'"
  );
  for (const [key, e] of idx) {
    const title = hanOnly(e.juan[0]?.name ?? "").replace(/卷第?[一二三四五六七八九十百千〇○零]+$/, "");
    for (const j of e.juan) {
      const curNum = intToCnNumeral(j.juan);
      const rows = stmt.all(j.vol, j.start_seq, j.end_seq) as { text: string }[];
      for (const r of rows) {
        const h = hanOnly(r.text ?? "");
        const m = HDR_RE.exec(h);
        if (!m) continue;
        if (title.length >= 2 && !h.startsWith(title.slice(0, 2))) continue;
        const num = m[2];
        // 標題折行會截斷數字（如「卷第一百」實為「卷第一百一十」），略過
        if (num === curNum || num.startsWith(curNum) || curNum.startsWith(num)) continue;
        const n = cnNumeralToInt(num);
        if (n > 0 && n !== j.juan && n <= e.juanCount) {
          out.set(`${key}/${j.juan}`, `卷範圍內出現「${h}」，卷界與刻本不符`);
          break;
        }
      }
    }
  }
  return out;
}
