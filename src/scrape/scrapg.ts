// scrapg.ts — 高麗藏（東國大學 KABC）抓取工具，取代手刻的 scrap-goryeo.js
//
// 舊版的核心困難：不知道分卷邊界，東國大學的 API 又必須帶卷號，所以只能
// 「抓不到內容就猜是換卷」→ 每個卷界都會吃掉一頁，而且同一頁要重複抓。
// 現在 juaninfo.tsv 已有每一卷的起訖頁欄行，卷號不再是猜的。
//
// 用法：
//   bun scrapg.ts plan                      盤點缺頁 → goryeo-gaps.tsv
//   bun scrapg.ts fetch [--dry] [--limit N] 補抓缺頁 → goryeo-raw-html/fill-<經號>.html
//   bun scrapg.ts get <經號> <卷> <vol> <page> [col]   抓單欄並印出（除錯用）
//   bun scrapg.ts verify                   補抓結果的基本檢查
//
// API：https://kabc.dongguk.edu/viewer/ajaxText?dataId=ABC_IT_K<經號>_T_<卷:3>&imgId=<冊:3>_<頁:4>_<欄>
// 回應含兩個 xsl_body：--ori 是原文（我們要的），--trans 是韓文翻譯（丟棄）。

import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync, copyFileSync } from "fs";
import { join } from "path";

const RAW = "goryeo-raw-html";
const JUANINFO = "k-txt/juaninfo.tsv";
const GAPS = "goryeo-gaps.tsv";
const BASE = "https://kabc.dongguk.edu/viewer/ajaxText?dataId=ABC_IT_K";

/** KABC 把少數大經切成多個 dataId；鍵是後綴，值是「實際卷號 − API 卷參數」的偏移 */
const OFFSET: Record<string, number> = { a: 0, b: 150, c: 300, d: 450 };
const SPECIAL: Record<string, Record<string, number>> = {
  "0648": { b: 25 }, "0952": { b: 170 },
};
const pad = (n: number, w: number) => String(n).padStart(w, "0");

// ---------------------------------------------------------------- 抓取

const cache = new Map<string, string>();
/** 這次抓到的原始 HTML 片段，依 dataId 收集（保留韓文，最後追加進該經自己的檔案） */
const chunkOut = new Map<string, string[]>();
async function raw(sutra: string, juan: number, vol: number, page: number, col: string, retry = 3): Promise<string> {
  const k = `${sutra}/${juan}/${vol}/${page}/${col}`;
  const hit = cache.get(k);
  if (hit !== undefined) return hit;
  const url = `${BASE}${sutra}_T_${pad(juan, 3)}&imgId=${pad(vol, 3)}_${pad(page, 4)}_${col}`;
  for (let i = 0; i < retry; i++) {
    try {
      const r = await fetch(url, { tls: { rejectUnauthorized: false } } as any);
      const t = await r.text();
      cache.set(k, t);
      return t;
    } catch (e) {
      if (i === retry - 1) { console.error(`抓取失敗 ${url}: ${e}`); return ""; }
      await sleep(600 * (i + 1));
    }
  }
  return "";
}

/** 取出原文（--ori）＋韓文翻譯（--trans）兩段，合成與原始檔相同的片段（韓文要留著） */
export function extractChunk(t: string): string {
  const a = t.indexOf('data-xsl-type="원문"');
  if (a < 0) return "";
  const s = t.indexOf(">", a) + 1;
  const tb = t.indexOf("viewer__wrap__text__body--trans", s);
  const ori = t.slice(s, tb > 0 ? tb : t.length).replace(/<\/div>[\s\S]*$/, "").trim();
  let trans = "";
  const ta = t.indexOf('data-xsl-type="번역문"', tb > 0 ? tb : 0);
  if (ta > 0) {
    const ts = t.indexOf(">", ta) + 1;
    trans = t.slice(ts).replace(/<\/div>[\s\S]*$/, "").trim();
  }
  return ori + (trans ? `<TRANS>${trans}</TRANS>` : "");
}

/** 取出原文（--ori）那一段 HTML；翻譯段丟掉 */
export function extractOri(t: string): string {
  const a = t.indexOf('data-xsl-type="원문"');
  if (a < 0) return "";
  const s = t.indexOf(">", a) + 1;
  const b = t.indexOf("viewer__wrap__text__body--trans", s);
  let seg = t.slice(s, b > 0 ? b : t.length);
  seg = seg.replace(/<\/div>[\s\S]*$/, "");       // 去掉尾端收尾標籤
  return seg.trim();
}

/** 這一段原文裡有哪些行（vol_page_col_line → 文字） */
const LINE_RE = /data-xsl-lineid="(\d{3})_(\d{4})_([abc])_(\d{2})L"[^>]*>[\s\S]*?<\/span>([\s\S]*?)(?=<span data-xsl-lineid|$)/g;
export function parseLines(seg: string): { pcl: string; text: string }[] {
  const out: { pcl: string; text: string }[] = [];
  for (const m of seg.matchAll(LINE_RE)) {
    const text = m[5]
      .replace(/<br[^>]*>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "〈").replace(/&gt;/g, "〉").replace(/&amp;/g, "&")
      .trim();
    out.push({ pcl: m[2] + m[3] + m[4], text });
  }
  return out;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchPage(sutra: string, juan: number, vol: number, page: number) {
  const cols = ["a", "b", "c"];
  const lines: { col: string; pcl: string; text: string }[] = [];
  const chunks: string[] = [];
  for (const col of cols) {
    const t = await raw(sutra, juan, vol, page, col);
    const c = extractChunk(t);
    if (c) chunks.push(c);
    for (const l of parseLines(extractOri(t))) lines.push({ col, pcl: l.pcl, text: l.text });
  }
  return { lines, chunks };
}

// ---------------------------------------------------------------- 索引

interface KJuan { sutra: string; vol: number; juan: number; start: string; end: string }
function readJuaninfo(): KJuan[] {
  const out: KJuan[] = [];
  for (const line of readFileSync(JUANINFO, "utf-8").split(/\r?\n/)) {
    const c = line.split("\t");
    if (c.length < 6 || !/^\d/.test(c[0])) continue;
    out.push({ sutra: c[0], vol: Number(c[1]), juan: Number(c[3]), start: c[4], end: c[5] });
  }
  return out;
}

/** goryeo-raw-html 裡每一部經用了哪些 dataId（有些大經切成 a/b/c/d） */
function dataIds(): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const f of readdirSync(RAW)) {
    if (!f.endsWith(".html") || f.startsWith("fill-")) continue;
    const id = f.replace(/\.html$/, "").replace(/-$/, "");
    const base = id.replace(/[a-z]$/, "");
    if (!m.has(base)) m.set(base, []);
    if (!m.get(base)!.includes(id)) m.get(base)!.push(id);
  }
  for (const v of m.values()) v.sort();
  return m;
}

/** 實際卷號 → API 卷參數；回傳 [dataId, juanParam] 候選 */
function juanCandidates(sutra: string, juan: number, ids: string[]): [string, number][] {
  const out: [string, number][] = [];
  for (const id of ids) {
    const suf = id.length > sutra.length ? id.slice(sutra.length) : "";
    const off = SPECIAL[sutra]?.[suf] ?? (suf ? OFFSET[suf] ?? 0 : 0);
    const p = juan - off;
    if (p >= 1 && p <= 999) out.push([id, p]);
  }
  return out;
}

// ---------------------------------------------------------------- plan

function plan(onlySutra?: string) {
  const db = new Database("K.db", { readonly: true });
  const have = new Map<number, Set<number>>();
  for (const r of db.query("SELECT DISTINCT vol, page FROM lines").all() as any[]) {
    if (!have.has(r.vol)) have.set(r.vol, new Set());
    have.get(r.vol)!.add(r.page);
  }
  db.close();

  const ji = readJuaninfo();
  const ids = dataIds();
  const byVol = new Map<number, KJuan[]>();
  for (const j of ji) { if (!byVol.has(j.vol)) byVol.set(j.vol, []); byVol.get(j.vol)!.push(j); }
  const pg = (pcl: string) => Number(pcl.slice(0, 4));

  const rows: string[] = ["經號\t冊\t頁\t候選卷\tdataId\tjuan參數\t類型"];
  let n = 0;
  for (const [vol, list] of [...byVol].sort((a, b) => a[0] - b[0])) {
    const ps = have.get(vol); if (!ps || ps.size === 0) continue;
    const sorted = [...ps].sort((a, b) => a - b);
    const haveSet = new Set(sorted);
    for (let p = sorted[0]; p <= sorted[sorted.length - 1]; p++) {
      if (haveSet.has(p)) continue;
      if (onlySutra && !list.some(j => j.sutra === onlySutra)) continue;
      // 這一頁夾在哪兩卷之間
      const sorted2 = [...list].sort((a, b) => pg(a.start) - pg(b.start));
      const before = sorted2.filter(j => pg(j.end) < p).pop();
      const after = sorted2.find(j => pg(j.start) > p);
      const cands: KJuan[] = [];
      if (before) cands.push(before);
      if (after) cands.push(after);
      if (!cands.length) { rows.push(["-", vol, p, "-", "-", "-", "無候選卷"].join("\t")); n++; continue; }
      for (const c of cands) {
        for (const [id, jp] of juanCandidates(c.sutra, c.juan, ids.get(c.sutra) ?? [c.sutra])) {
          rows.push([c.sutra, vol, p, c.juan, id, jp, cands.length > 1 ? "交界" : "唯一"].join("\t"));
          n++;
        }
      }
    }
  }
  writeFileSync(GAPS, rows.join("\n") + "\n");
  const pages = new Set(rows.slice(1).map(r => r.split("\t").slice(1, 3).join("/")));
  console.log(`【plan】缺頁 ${pages.size} 頁，展開為 ${n} 個 (dataId, 卷參數) 待試`);
  console.log(`       明細 → ${GAPS}`);
  const byVolN = new Map<string, number>();
  for (const r of rows.slice(1)) { const v = r.split("\t")[1]; byVolN.set(v, (byVolN.get(v) ?? 0) + 1); }
  console.log("       各冊：" + [...byVolN].slice(0, 20).map(([v, c]) => `${v}:${c}`).join(" "));
}

// ---------------------------------------------------------------- fetch

async function fetchGaps(opts: { dry?: boolean; limit?: number; concurrency?: number }) {
  if (!existsSync(GAPS)) { console.error(`請先跑 bun scrapg.ts plan`); process.exit(1); }
  const rows = readFileSync(GAPS, "utf-8").split(/\r?\n/).slice(1).filter(Boolean).map(l => l.split("\t"));
  // 依 (冊,頁) 分組，每組內依序試候選
  const groups = new Map<string, string[][]>();
  for (const r of rows) {
    if (r[0] === "-") continue;
    const k = `${r[1]}/${r[2]}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  let keys = [...groups.keys()];
  if (opts.limit) keys = keys.slice(0, opts.limit);
  console.log(`【fetch】${keys.length} 頁待處理（共 ${groups.size} 頁）${opts.dry ? "  [dry-run]" : ""}`);

  const out = new Map<string, string[]>();   // sutra → 片段
  let ok = 0, empty = 0, done = 0;
  const conc = opts.concurrency ?? 3;
  const queue = [...keys];

  const worker = async () => {
    while (queue.length) {
      const k = queue.shift()!;
      const cands = groups.get(k)!;
      const [volS, pageS] = k.split("/");
      const vol = Number(volS), page = Number(pageS);
      let hit: { sutra: string; juan: number; lines: { pcl: string; text: string }[] } | null = null;
      for (const r of cands) {
        const sutra = r[0], juan = Number(r[3]), id = r[4], jp = Number(r[5]);
        const { lines, chunks } = await fetchPage(id, jp, vol, page);
        const good = lines.filter(l => Number(l.pcl.slice(0, 4)) === page && l.text);
        if (good.length) { hit = { sutra, juan, lines: good }; if (!chunkOut.has(id)) chunkOut.set(id, []); chunkOut.get(id)!.push(...chunks); break; }
        await sleep(120);
      }
      done++;
      if (hit) {
        ok++;
        if (!out.has(hit.sutra)) out.set(hit.sutra, []);
        out.get(hit.sutra)!.push(`^j${hit.juan}`);
        out.get(hit.sutra)!.push(...hit.lines.map(l => `${l.pcl}\t${l.text}`));
        console.log(`  ✓ ${k}  → K${hit.sutra} 卷${hit.juan}  ${hit.lines.length} 行  ${hit.lines[0].text.slice(0, 30)}`);
      } else {
        empty++;
        console.log(`  · ${k}  網站無內容（試過 ${cands.length} 個卷參數）`);
      }
      if (done % 50 === 0) console.log(`  …進度 ${done}/${keys.length}（補回 ${ok}、無內容 ${empty}）`);
    }
  };
  if (opts.dry) { console.log("dry-run，不發請求"); return; }
  await Promise.all(Array.from({ length: conc }, worker));

  for (const [id, chunks] of chunkOut) {
    const p = join(RAW, `${id}.html`);
    if (existsSync(p) && !existsSync(p + ".bak")) copyFileSync(p, p + ".bak");
    appendFileSync(p, "\n<!-- 補抓 append -->\n" + chunks.join("\n") + "\n", "utf8");
    console.log(`【寫入】${p}  ${chunks.length} 欄（保留韓文，未加 ^j 標記）`);
  }
  console.log(`\n【fetch】完成：補回 ${ok} 頁、網站無內容 ${empty} 頁`);
}

// ---------------------------------------------------------------- 卷尾續抓
//
// 舊程式最常見的損失：某一卷還沒結束，卻因為一次空回應而誤判換卷，
// 於是「同一卷在記錄終點之後的內容」整段消失（例如 K1501 卷1 在 0062b22 之後
// 還有 page 63、64…）。這裡針對每一卷，從記錄終點往後用「同一個卷號」續抓，
// 直到連續若干欄為空為止。用大正藏的字數可以事後校驗補得夠不夠。
async function tailfill(sutras: string[], maxCols = 90, only?: Set<string>) {
  const ids = dataIds();
  const list = readJuaninfo().filter(j => sutras.includes(j.sutra) && (!only || only.has(`${j.sutra}/${j.juan}`)));
  const out = new Map<string, string[]>();
  let nJ = 0, nCol = 0, nLine = 0;
  for (const j of list) {
    const cands = juanCandidates(j.sutra, j.juan, ids.get(j.sutra) ?? [j.sutra]);
    let pg = Number(j.end.slice(0, 4));
    let ci = "abc".indexOf(j.end[4]) + 1;
    let empty = 0, steps = 0;
    const got: { pcl: string; text: string }[] = [];
    while (empty < 4 && steps < maxCols) {
      if (ci > 2) { ci = 0; pg++; }
      const col = "abc"[ci];
      steps++; nCol++;
      let lines: { pcl: string; text: string }[] = [];
      for (const [id, jp] of cands) {
        const r = await fetchPage(id, jp, j.vol, pg);
        lines = r.lines.filter(l => l.pcl[4] === col && Number(l.pcl.slice(0, 4)) === pg && l.text);
        if (lines.length) { if (!chunkOut.has(id)) chunkOut.set(id, []); chunkOut.get(id)!.push(...r.chunks); break; }
        await sleep(80);
      }
      if (lines.length) { got.push(...lines); empty = 0; } else empty++;
      ci++;
      await sleep(60);
    }
    if (got.length) {
      nJ++; nLine += got.length;
      if (!out.has(j.sutra)) out.set(j.sutra, []);
      out.get(j.sutra)!.push(`^j${j.juan}`, ...got.map(l => `${l.pcl}\t${l.text}`));
      console.log(`  ✓ K${j.sutra} 卷${j.juan}  終點 ${j.end} → 續抓 ${got.length} 行（到 ${got[got.length - 1].pcl}）`);
    }
  }
  for (const [id, chunks] of chunkOut) {
    const p = join(RAW, `${id}.html`);
    if (existsSync(p) && !existsSync(p + ".bak")) copyFileSync(p, p + ".bak");
    appendFileSync(p, "\n<!-- 補抓 append -->\n" + chunks.join("\n") + "\n", "utf8");
    console.log(`【寫入】${p}  ${chunks.length} 欄（保留韓文，未加 ^j 標記）`);
  }
  console.log(`\n【tail】${nJ} 卷有續抓內容、共 ${nLine} 行；送出 ${nCol} 欄查詢`);
}

// ---------------------------------------------------------------- 除錯

async function get(sutra: string, juan: number, vol: number, page: number, col = "a") {
  const seg = extractOri(await raw(sutra, juan, vol, page, col));
  const lines = parseLines(seg);
  console.log(`K${sutra} 卷${juan} ${pad(vol, 3)}_${pad(page, 4)}_${col}  → ${lines.length} 行`);
  for (const l of lines.slice(0, 6)) console.log(`  ${l.pcl}\t${l.text}`);
}

// ---------------------------------------------------------------- 主流程

const [cmd, ...args] = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
switch (cmd) {
  case "plan": plan(args.find(a => /^\d/.test(a))); break;
  case "fetch": await fetchGaps({ dry: args.includes("--dry"), limit: Number(flag("--limit")) || undefined, concurrency: Number(flag("--concurrency")) || 3 }); break;
  case "get": await get(args[0], Number(args[1]), Number(args[2]), Number(args[3]), args[4]); break;
  case "tail": {
    if (flag("--list")) {
      const only = new Set<string>();
      for (const line of readFileSync(flag("--list")!, "utf-8").split(/\r?\n/)) {
        const c = line.split("\t");
        if (c.length >= 2 && /^\d/.test(c[0])) only.add(`${c[0]}/${c[1]}`);
      }
      const ss = [...new Set([...only].map(x => x.split("/")[0]))];
      await tailfill(ss, Number(flag("--max")) || 40, only);
      break;
    }
    let ss = args.filter(a => /^\d/.test(a));
    if (!ss.length) ss = [...new Set(readJuaninfo().map(j => j.sutra))];
    await tailfill(ss, Number(flag("--max")) || 90);
    break;
  }
  default:
    console.log(`用法：
  bun scrapg.ts plan [經號]                 盤點缺頁 → ${GAPS}
  bun scrapg.ts fetch [--dry] [--limit N]   補抓缺頁 → 追加進 ${RAW}/<經號>.html
  bun scrapg.ts tail [經號…] [--max N]      卷尾續抓（救回被截斷的卷）→ 同樣追加進該經自己的檔案
  bun scrapg.ts get <經號> <卷> <冊> <頁> [欄]  抓單欄（除錯）`);
}
