// makejuaninfo.ts — 產生修正後的 juaninfo.tsv（K 與 T）
//
// 用法：
//   bun makejuaninfo.ts            # 產生（舊檔自動備份為 juaninfo.orig.tsv）
//   bun makejuaninfo.ts --check    # 只檢查，不寫檔
//
// 修正／新增的內容：
//   1. 冊號：K.db 的 juan.vol 與 lines.vol 是兩套不同分冊，原 juaninfo 的冊號
//      有 1674 卷是錯的（照它取文會取到別部經）。這裡改用重建後的正確冊號。
//      T 的冊號經檢查與 lines.vol 一致，不動。
//   2. 總行數：原欄位與實際行數不符（6596 卷中僅 964 卷相符，多數多 2 行），
//      一律按起訖頁行碼實際包含的行數重算。
//   3. 新增 序言行數、附文行數、序言字數、附文字數 四欄（見下方說明）。
//   經名、卷號、起點、終點維持原值。
//
// 序言／附文的來源：與 comparejuan.ts 相同範圍的一對一配對（對照表 exact 且兩藏卷數相同），
// 逐卷 diff 後取「開頭／結尾只出現在單邊」的區段。不在該範圍內的卷一律填 0。
//   序言行數＝該卷開頭屬於序言的行數（正文從其後開始；若序言在某行中結束，該行仍算正文）
//   附文行數＝該卷結尾屬於附文的行數（正文到其前結束）
//   序言字數／附文字數＝該區段的漢字數
// 因此「只讀正文」＝跳過前 序言行數 行、並去掉後 附文行數 行。

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "fs";
import { openDb, buildGoryeoIndex, buildTaishoIndex, loadMapping, readJuan, normSutra, hanOnly } from "../core/juanindex";
import { compareHanzi } from "../core/similarity";

const KDB = "K.db", TDB = "T.db";
const K_JI = "k-txt/juaninfo.tsv", T_JI = "t-txt/juaninfo.tsv";
const CHECK = process.argv.includes("--check");

const HEAD = ["經號", "冊號", "經名", "卷號", "起點", "終點", "總行數", "序言行數", "附文行數", "序言字數", "附文字數"];

// ---------------------------------------------------------------- 讀來源

interface SrcRow { c: string[]; line: number }
function readJI(path: string): { head: string[]; rows: SrcRow[] } {
  const raw = readFileSync(path, "utf-8").split(/\r?\n/);
  const head = raw[0].split("\t");
  const rows: SrcRow[] = [];
  for (let i = 1; i < raw.length; i++) {
    if (!raw[i].trim()) continue;
    const c = raw[i].split("\t");
    if (c.length < 7 || !/^\d/.test(c[0])) { console.warn(`  跳過格式異常列 ${i + 1}: ${raw[i].slice(0, 50)}`); continue; }
    rows.push({ c, line: i + 1 });
  }
  return { head, rows };
}

// ---------------------------------------------------------------- 主流程

const t0 = Date.now();
const kdb = openDb(KDB), tdb = openDb(TDB);
console.log("[索引] 重建 K 卷索引（以現有 K.db 的 lines 為準）…");
const kIdx = buildGoryeoIndex(kdb, m => console.log(`[索引] ${m}`));
const tIdx = buildTaishoIndex(tdb);
const mapping = loadMapping();

/** key = 經號/卷號 -> {vol, lines, preLines, postLines, preChars, postChars} */
interface Fix { vol: number; lines: number; preLines: number; postLines: number; preChars: number; postChars: number }
const kFix = new Map<string, Fix>();
const tFix = new Map<string, Fix>();

// 1) 先用實際行數填好每一卷
for (const [s, e] of kIdx) for (const j of e.juan) {
  kFix.set(`${s}/${j.juan}`, { vol: j.vol, lines: 0, preLines: 0, postLines: 0, preChars: 0, postChars: 0 });
}

// 2) 對可比對的配對逐卷 diff，算出序言／附文
const pairs: { k: string; t: string }[] = [];
for (const [k, ki] of [...kIdx].sort((a, b) => a[0].localeCompare(b[0]))) {
  const m = mapping.get(k);
  if (!m || m.kind !== "exact") continue;
  const ti = tIdx.get(normSutra(m.target!).toUpperCase());
  if (!ti || ti.juanCount !== ki.juanCount) continue;
  pairs.push({ k, t: m.target! });
}
console.log(`[範圍] ${pairs.length} 部經可比對，開始逐卷計算序言／附文…`);

let done = 0;
const fill = (key: string, t: ReturnType<typeof readJuan>, preChars: number, postChars: number) => {
  const total = t.lines.length;
  const preLines = preChars === 0 ? 0 : (t.lineOfChar[preChars] ?? 0);
  const bodyEnd = t.hanzi.length - postChars;
  const postLines = postChars === 0 ? 0 : Math.max(0, total - 1 - (t.lineOfChar[bodyEnd - 1] ?? total - 1));
  return { lines: total, preLines, postLines, preChars, postChars };
};

for (const p of pairs) {
  const ki = kIdx.get(p.k)!, ti = tIdx.get(normSutra(p.t).toUpperCase())!;
  for (const kRec of ki.juan) {
    const tRec = ti.juan.find(j => j.juan === kRec.juan);
    if (!tRec) continue;
    const kt = readJuan(kdb, kRec), tt = readJuan(tdb, tRec);
    const d = compareHanzi(kt.hanzi, tt.hanzi);
    const kf = kFix.get(`${p.k}/${kRec.juan}`)!;
    const tf = tFix.get(`${p.t.toUpperCase()}/${tRec.juan}`) ?? { vol: tRec.vol, lines: 0, preLines: 0, postLines: 0, preChars: 0, postChars: 0 };
    Object.assign(kf, { vol: kRec.vol }, fill(`${p.k}/${kRec.juan}`, kt, d.preA, d.postA));
    Object.assign(tf, { vol: tRec.vol }, fill(`${p.t.toUpperCase()}/${tRec.juan}`, tt, d.preB, d.postB));
    tFix.set(`${p.t.toUpperCase()}/${tRec.juan}`, tf);
    done++;
  }
  if (done % 1000 === 0) console.log(`   …${done} 卷`);
}
console.log(`[範圍] 完成 ${done} 卷`);

// 3) 補上未被 diff 涵蓋的卷（只填實際行數）
//
// 少數列（例如 T2266 卷 11、12）因為舊 packdb.ts 的頁行碼正則只接受 a-d 欄，
// 根本沒進到舊 DB，這裡改為直接從來源 TSV 數行數。
const PCL_RE = /^(\d{4})([a-g])(\d{2})$/;
const seqOf = (pcl: string): number | null => {
  const m = PCL_RE.exec(pcl.toLowerCase());
  if (!m) return null;
  return Number(m[1]) * 1000 + (m[2].charCodeAt(0) - 97) * 100 + Number(m[3]);
};
const volCache = new Map<string, number[]>();
function volSeqs(dir: string, vol: number): number[] {
  const key = `${dir}/${vol}`;
  const hit = volCache.get(key);
  if (hit) return hit;
  const name = `${dir.split("/").pop()![0].toUpperCase()}${String(vol).padStart(2, "0")}.tsv`;
  const seqs: number[] = [];
  try {
    for (const raw of readFileSync(`${dir}/${name}`, "utf-8").split(/\r?\n/)) {
      if (!raw) continue;
      const tab = raw.indexOf("\t");
      const s = seqOf(tab === -1 ? raw : raw.slice(0, tab));
      if (s !== null) seqs.push(s);
    }
  } catch { console.warn(`  找不到來源檔 ${dir}/${name}`); }
  seqs.sort((a, b) => a - b);
  volCache.set(key, seqs);
  return seqs;
}
function countFromSource(dir: string, vol: number, start: string, end: string): number {
  const s = seqOf(start), e = seqOf(end);
  if (s === null || e === null) return 0;
  const seqs = volSeqs(dir, vol);
  let lo = 0, hi = seqs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (seqs[m] < s) lo = m + 1; else hi = m; }
  let n = 0;
  for (let i = lo; i < seqs.length && seqs[i] <= e; i++) n++;
  return n;
}

function fillRest(idx: Map<string, any>, map: Map<string, Fix>, db: any, label: string) {
  let n = 0;
  for (const [s, e] of idx) for (const j of e.juan) {
    const key = `${label === "K" ? s : s.toUpperCase()}/${j.juan}`;
    if (map.has(key)) continue;
    const t = readJuan(db, j);
    map.set(key, { vol: j.vol, lines: t.lines.length, preLines: 0, postLines: 0, preChars: 0, postChars: 0 });
    n++;
  }
  console.log(`[補齊] ${label} 另有 ${n} 卷（無可比對對象），序言／附文填 0`);
}
fillRest(kIdx, kFix, kdb, "K");
fillRest(tIdx, tFix, tdb, "T");

// 4) 輸出
function build(path: string, map: Map<string, Fix>, isK: boolean, dir: string): { text: string; stats: any } {
  const { rows } = readJI(path);
  const out: string[] = [HEAD.join("\t")];
  let volFixed = 0, totalFixed = 0, missing = 0;
  const volPad = isK ? 2 : 0;
  for (const r of rows) {
    const [sutra, volStr, name, juanStr, start, end, totalStr] = r.c;
    const key = `${isK ? sutra : sutra.toUpperCase()}/${Number(juanStr)}`;
    const vol = Number(volStr);
    let f = map.get(key);
    if (!f) {
      // 舊 DB 沒有這一列（來源有、DB 沒有）：直接從來源 TSV 數行數
      missing++;
      const lines = countFromSource(dir, vol, start, end);
      f = { vol, lines, preLines: 0, postLines: 0, preChars: 0, postChars: 0 };
      console.log(`  ${isK ? "K" : "T"}${sutra}/${Number(juanStr)} 舊 DB 無此列，由來源數得 ${lines} 行`);
    }
    let volOut = String(f.vol);
    if (volPad && /^0\d$/.test(volStr)) volOut = volOut.padStart(2, "0");
    if (Number(volStr) !== f.vol) volFixed++;
    if (Number(totalStr) !== f.lines) totalFixed++;
    out.push([sutra, volOut, name, juanStr, start, end, String(f.lines), String(f.preLines), String(f.postLines), String(f.preChars), String(f.postChars)].join("\t"));
  }
  return { text: out.join("\n") + "\n", stats: { rows: rows.length, volFixed, totalFixed, missing } };
}

const kb = build(K_JI, kFix, true, "k-txt");
const tb = build(T_JI, tFix, false, "t-txt");
console.log(`\nK juaninfo：${kb.stats.rows} 列；冊號修正 ${kb.stats.volFixed} 列；總行數重算 ${kb.stats.totalFixed} 列；舊 DB 缺列 ${kb.stats.missing} 列`);
console.log(`T juaninfo：${tb.stats.rows} 列；冊號修正 ${tb.stats.volFixed} 列；總行數重算 ${tb.stats.totalFixed} 列；舊 DB 缺列 ${tb.stats.missing} 列`);

if (CHECK) { console.log("\n（--check：未寫入檔案）"); process.exit(0); }

for (const [src, orig] of [[K_JI, "k-txt/juaninfo.orig.tsv"], [T_JI, "t-txt/juaninfo.orig.tsv"]] as [string, string][]) {
  if (!existsSync(orig)) { copyFileSync(src, orig); console.log(`[備份] ${src} -> ${orig}`); }
  else console.log(`[備份] ${orig} 已存在，保留不動`);
}
writeFileSync(K_JI, kb.text, "utf-8");
writeFileSync(T_JI, tb.text, "utf-8");
console.log(`[輸出] 已寫入 ${K_JI} 與 ${T_JI}（耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);

kdb.close();
tdb.close();
