// api.ts — 数据访问层。全部返回数据，不打印。
// 对应 sqlaccess.md 中的 API: PclByJuan / pclRange / SutraJuanByPcl /
// getJuan / getJuanWithPCL / juanCount，并附少量 CLI 需要的辅助。

import { Database } from "bun:sqlite";
import { readdirSync, statSync } from "fs";
import { join } from "path";

// ---------- 类型 ----------

export interface JuanRange {
  sutra: string;
  vol: number;
  juan: number;
  start_pcl: string;
  end_pcl: string;
  total_lines: number | null;
  /** 卷首属于序言的行数（正文从其後开始） */
  preface_lines: number | null;
  /** 卷末属于附文的行数（正文到其前结束） */
  appendix_lines: number | null;
  /** 序言／附文的汉字数 */
  preface_chars: number | null;
  appendix_chars: number | null;
}

export interface SutraJuan {
  sutra: string;
  juan: number;
}

// ---------- 连接管理 ----------

let db: Database | null = null;

export function openDb(path?: string): void {
  if (db) return;
  const p = path ?? findDb();
  if (!p) throw new Error("找不到 .db 文件，请先运行 packdb.ts");
  db = new Database(p, { readonly: true });
}

export function closeDb(): void {
  db?.close();
  db = null;
}

function getDb(): Database {
  if (!db) openDb();
  return db!;
}

function findDb(): string | null {
  for (const d of ["txt", "."]) {
    if (!statSync(d, { throwIfNoEntry: false })?.isDirectory()) continue;
    const files = readdirSync(d).filter(f => f.endsWith(".db"));
    if (files.length === 0) continue;
    //const preferred = files.find(f => f === "T.db"||f==="K.db") ?? files[0];
    return join(d, files[0]);//選第一個
  }
  return null;
}

// ---------- PCL 工具 ----------

export function normalizePCL(s: string): string | null {
  s = s.trim().toLowerCase();
  const m = /^(\d{1,4})([a-g])(\d{1,2})$/.exec(s);
  if (!m) return null;
  return m[1].padStart(4, "0") + m[2] + m[3].padStart(2, "0");
}

export function normalizeSutra(s: string): string {
  const t = s.trim();
  const m = /^(\d+)([A-Za-z]?)$/.exec(t);
  if (!m) return t;
  return m[1].padStart(4, "0") + m[2];
}

function pclToSeq(pcl: string): number | null {
  const m = /^(\d{4})([a-g])(\d{2})$/.exec(pcl);
  if (!m) return null;
  const page = Number(m[1]);
  const colIdx = m[2].charCodeAt(0) - 97; // a=0, b=1, c=2, d=3
  const line = Number(m[3]);
  return page * 1000 + colIdx * 100 + line;
}

// ---------- API ----------

// 某卷的册号、起止页行码
export function PclByJuan(sutra: string, juan = 1): JuanRange | null {
  const s = normalizeSutra(sutra);
  return getDb().query(`
    SELECT sutra, vol, juan, start_pcl, end_pcl, total_lines,
           preface_lines, appendix_lines, preface_chars, appendix_chars
    FROM juan
    WHERE LOWER(sutra) = LOWER(?) AND juan = ?
  `).get(s, juan) as JuanRange | null;
}

// 给定 [start, end] 返回 pcl 数组；end 缺省时读到 start 所在页末尾
export function pclRange(vol: number, start_pcl: string, end_pcl?: string): string[] {
  const s = normalizePCL(start_pcl);
  if (!s) return [];
  // 欄號可到 g（a-g），故預設讀到本頁最後一欄
  const end = end_pcl ? normalizePCL(end_pcl) : (s.slice(0, 4) + "g99");
  if (!end) return [];
  const sSeq = pclToSeq(s)!;
  const eSeq = pclToSeq(end)!;
  const rows = getDb().query(`
    SELECT pcl FROM lines
    WHERE vol = ? AND seq >= ? AND seq <= ?
    ORDER BY seq
  `).all(vol, sSeq, eSeq) as { pcl: string }[];
  return rows.map(r => r.pcl);
}

// 给定册号 + pcl 返回经号、卷号
export function SutraJuanByPcl(vol: number, pcl: string): SutraJuan | null {
  const p = normalizePCL(pcl);
  if (!p) return null;
  const seq = pclToSeq(p)!;
  return getDb().query(`
    SELECT sutra, juan FROM juan
    WHERE vol = ? AND start_seq <= ? AND end_seq >= ?
    ORDER BY juan
    LIMIT 1
  `).get(vol, seq, seq) as SutraJuan | null;
}

// 某卷经文（纯文本）
export function getJuan(sutra: string, juan = 1): string[] {
  return getJuanWithPCL(sutra, juan).map(s => s.slice(s.indexOf("\t") + 1));
}

// 某卷经文（带 pcl，形如 "0001a02\tNo.1"）
export function getJuanWithPCL(sutra: string, juan = 1): string[] {
  const range = PclByJuan(sutra, juan);
  if (!range) return [];
  const s = pclToSeq(range.start_pcl);
  const e = pclToSeq(range.end_pcl);
  if (s === null || e === null) return [];
  const rows = getDb().query(`
    SELECT pcl, text FROM lines
    WHERE vol = ? AND seq >= ? AND seq <= ?
    ORDER BY seq
  `).all(range.vol, s, e) as { pcl: string; text: string }[];
  return rows.map(r => `${r.pcl}\t${r.text}`);
}

// 某卷的正文（纯文本）：跳过卷首的序言，并去掉卷末的附文
//
// 序言／附文的行数记在 juan 表的 preface_lines / appendix_lines 栏
// （由 juaninfo.tsv 带入，见 juanmap-notes.md）。两者都是 0 时等同 getJuan。
export function getJuanBody(sutra: string, juan = 1): string[] {
  return getJuanBodyWithPCL(sutra, juan).map(s => s.slice(s.indexOf("\t") + 1));
}

// 某卷的正文（带 pcl）
export function getJuanBodyWithPCL(sutra: string, juan = 1): string[] {
  const range = PclByJuan(sutra, juan);
  if (!range) return [];
  const rows = getJuanWithPCL(sutra, juan);
  const from = Math.min(Math.max(range.preface_lines ?? 0, 0), rows.length);
  const to = Math.max(from, rows.length - Math.max(range.appendix_lines ?? 0, 0));
  return rows.slice(from, to);
}

// 某卷的序言与附文（纯文本），方便单独取用
export function getJuanPreface(sutra: string, juan = 1): string[] {
  const range = PclByJuan(sutra, juan);
  if (!range) return [];
  const rows = getJuanWithPCL(sutra, juan);
  const n = Math.min(Math.max(range.preface_lines ?? 0, 0), rows.length);
  return rows.slice(0, n).map(s => s.slice(s.indexOf("\t") + 1));
}

export function getJuanAppendix(sutra: string, juan = 1): string[] {
  const range = PclByJuan(sutra, juan);
  if (!range) return [];
  const rows = getJuanWithPCL(sutra, juan);
  const n = Math.min(Math.max(range.appendix_lines ?? 0, 0), rows.length);
  return rows.slice(rows.length - n).map(s => s.slice(s.indexOf("\t") + 1));
}

// 某经有多少卷（大小写不敏感）
export function juanCount(sutra: string): number {
  const s = normalizeSutra(sutra);
  const row = getDb().query(
    "SELECT COUNT(*) AS n FROM juan WHERE LOWER(sutra) = LOWER(?)"
  ).get(s) as { n: number };
  return row.n;
}

// ---------- CLI 辅助 ----------

// 某册是否存在
export function hasVol(vol: number): boolean {
  return !!getDb().query("SELECT 1 FROM lines WHERE vol = ? LIMIT 1").get(vol);
}

// 某册中某 pcl 是否存在
export function hasPcl(vol: number, pcl: string): boolean {
  const p = normalizePCL(pcl);
  if (!p) return false;
  return !!getDb().query(
    "SELECT 1 FROM lines WHERE vol = ? AND pcl = ? LIMIT 1"
  ).get(vol, p);
}

// 某册第一行的 pcl
export function firstPcl(vol: number): string | null {
  const r = getDb().query(
    "SELECT pcl FROM lines WHERE vol = ? ORDER BY seq LIMIT 1"
  ).get(vol) as { pcl: string } | null;
  return r?.pcl ?? null;
}

// 从指定 pcl 起取 n 行（带 pcl）
export function linesFromPcl(vol: number, pcl: string, n: number): string[] {
  const p = normalizePCL(pcl);
  if (!p) return [];
  const seq = pclToSeq(p)!;
  const rows = getDb().query(`
    SELECT pcl, text FROM lines
    WHERE vol = ? AND seq >= ?
    ORDER BY seq LIMIT ?
  `).all(vol, seq, n) as { pcl: string; text: string }[];
  return rows.map(r => `${r.pcl}\t${r.text}`);
}

// 某册最开头 n 行（带 pcl）
export function headOfVol(vol: number, n: number): string[] {
  const rows = getDb().query(`
    SELECT pcl, text FROM lines
    WHERE vol = ?
    ORDER BY seq LIMIT ?
  `).all(vol, n) as { pcl: string; text: string }[];
  return rows.map(r => `${r.pcl}\t${r.text}`);
}