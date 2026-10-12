// cbtool.ts — CBETA TEI XML ⇄ SAT 2018 的位置比對工具
//
// 用法：
//   bun cbtool.ts scan                    全藏掃描，逐卷比對 CBETA 與 SAT 的卷界，輸出 cbeta-sat-diff.tsv
//   bun cbtool.ts scan T20                只掃一冊
//   bun cbtool.ts convert <xml> [out]     把一個 CBETA XML 轉成 SAT 格式（pcl<TAB>文字）
//   bun cbtool.ts diff <冊> <經號> [卷]   逐 lb 並列 CBETA 與 SAT，標出異同
//   bun cbtool.ts sample <檔>             印出一個 XML 的標籤結構樣本
//
// SAT 側的資料來自 t-txt/*.tsv（各卷起訖見 t-txt/juaninfo.tsv）。
// CBETA 側以 <lb n="NNNNaNN"> 為行，一卷一檔（T20n1169_001.xml = 第 20 冊 No.1169 卷 1）。

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from "fs";
import { join } from "path";

const CB = "cbeta";

// ---------------------------------------------------------------- 共用

const seq = (p: string) => Number(p.slice(0, 4)) * 1000 + (p.charCodeAt(4) - 97) * 100 + Number(p.slice(5));
const LB_RE = /<lb n="(\d{4}[a-g]\d{2})"[^>]*\/>/g;

/** 把一段 TEI 片段化成純文字：去校勘記、去異文、去標籤；保留 <lem>（底本文字） */
function teaToText(s: string): string {
  return s
    .replace(/<note\b[^>]*\/>/g, "")
    .replace(/<note\b[^>]*>[\s\S]*?<\/note>/g, "")
    .replace(/<rdg\b[^>]*\/>/g, "")
    .replace(/<rdg\b[^>]*>[\s\S]*?<\/rdg>/g, "")
    .replace(/<cb:mulu\b[^>]*\/>/g, "")
    .replace(/<cb:mulu\b[^>]*>[\s\S]*?<\/cb:mulu>/g, "")
    .replace(/<space\b[^>]*\/>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .replace(/\s+/g, "");
}

/** 讀一個 CBETA XML：回傳 lb → 純文字 */
function readCbeta(path: string): { lbs: string[]; text: Map<string, string>; raw: Map<string, string> } {
  let xml = readFileSync(path, "utf-8");
  const a = xml.indexOf("<text>"), b = xml.indexOf("</text>");
  if (a >= 0 && b > a) xml = xml.slice(a, b);
  const lbs: string[] = [];
  const text = new Map<string, string>();
  const raw = new Map<string, string>();
  const parts = xml.split(LB_RE);
  for (let i = 1; i < parts.length; i += 2) {
    const lb = parts[i];
    const body = parts[i + 1] ?? "";
    lbs.push(lb);
    text.set(lb, teaToText(body));
    raw.set(lb, body);
  }
  return { lbs, text, raw };
}

/** SAT 側：一次讀進某冊的 TSV */
function readSat(vol: string): Map<string, string> {
  const m = new Map<string, string>();
  const p = join("t-txt", `${vol}.tsv`);
  if (!existsSync(p)) return m;
  for (const line of readFileSync(p, "utf-8").split(/\r?\n/)) {
    const i = line.indexOf("\t");
    if (i < 0) continue;
    m.set(line.slice(0, i), line.slice(i + 1));
  }
  return m;
}

/** SAT juaninfo：經號 → 卷 → 起訖行數 */
function readJuaninfo(): Map<string, { juan: number; start: string; end: string; lines: number }[]> {
  const out = new Map<string, { juan: number; start: string; end: string; lines: number }[]>();
  const p = join("t-txt", "juaninfo.tsv");
  for (const line of readFileSync(p, "utf-8").split(/\r?\n/)) {
    const c = line.split("\t");
    if (c.length < 7 || !/^\d/.test(c[0])) continue;
    const k = c[0].toUpperCase();
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push({ juan: Number(c[3]), start: c[4], end: c[5], lines: Number(c[6]) });
  }
  return out;
}

/** 標點／空白正規化：只留漢字與悉曇轉寫用的字母，用來判斷「文字是否相同」 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ffff}]/gu;
const hanOf = (s: string) => (s.match(CJK) ?? []).join("");

// ---------------------------------------------------------------- scan

function scan(only?: string) {
  const ji = readJuaninfo();
  const vols = readdirSync(CB).filter(d => /^T\d\d$/.test(d) && (!only || d === only)).sort();
  const rows: string[] = ["CBETA檔\t經號\t卷\tCB首lb\tCB末lb\tCB行數\tSAT起點\tSAT終點\tSAT行數\t起點差\t行數差\t判定"];
  let n = 0, sameStart = 0, diffStart = 0, noSat = 0;
  const byVol = new Map<string, { n: number; diff: number }>();

  for (const v of vols) {
    const dir = join(CB, v);
    let files: string[];
    try { files = readdirSync(dir).filter(f => f.endsWith(".xml")).sort(); } catch { continue; }
    const satCache = new Map<string, Map<string, string>>();
    for (const f of files) {
      const m = /^T(\d\d)n(\d+)([a-z]?)_(\d{3})\.xml$/.exec(f);
      if (!m) continue;
      const vol = m[1], no = m[2] + (m[3] ? m[3].toUpperCase() : ""), juan = Number(m[4]);
      const { lbs } = readCbeta(join(dir, f));
      if (lbs.length === 0) continue;
      const cbFirst = lbs[0], cbLast = lbs[lbs.length - 1], cbN = lbs.length;
      const list = ji.get(no);
      const rec = list?.find(x => x.juan === juan);
      n++;
      let verdict = "";
      if (!rec) { noSat++; verdict = "SAT 無此卷（未收或卷數不同）"; rows.push([f, no, juan, cbFirst, cbLast, cbN, "", "", "", "", "", verdict].join("\t")); continue; }
      const d = seq(cbFirst) - seq(rec.start);
      const dl = cbN - rec.lines;
      const key = `${vol}`;
      if (!byVol.has(key)) byVol.set(key, { n: 0, diff: 0 });
      byVol.get(key)!.n++;
      if (d === 0) sameStart++; else { diffStart++; byVol.get(key)!.diff++; }
      verdict = d === 0 ? (dl === 0 ? "一致" : `同起點但行數差 ${dl}`) : `起點差 ${d > 0 ? "+" : ""}${d} 行（CBETA ${d > 0 ? "晚" : "早"}）`;
      rows.push([f, no, juan, cbFirst, cbLast, cbN, rec.start, rec.end, rec.lines, d, dl, verdict].join("\t"));
    }
    void satCache;
  }
  writeFileSync("cbeta-sat-diff.tsv", rows.join("\n") + "\n");
  console.log(`【掃描】CBETA ${n} 卷`);
  console.log(`  卷起點相同 ${sameStart}、不同 ${diffStart}、SAT 查無此卷 ${noSat}`);
  console.log(`  明細 → cbeta-sat-diff.tsv`);
  const diffs = rows.slice(1).filter(r => { const d = Number(r.split("\t")[9]); return d !== 0; });
  console.log(`\n  起點不同的前 25 例：`);
  for (const r of diffs.slice(0, 25)) {
    const c = r.split("\t");
    console.log(`    ${c[0]}  CB ${c[3]}  SAT ${c[6]}  差 ${c[9]}`);
  }
  console.log(`\n  各冊不同卷數（前 15 冊）：`);
  const bv = [...byVol.entries()].filter(([, x]) => x.diff > 0).sort((a, b) => b[1].diff - a[1].diff).slice(0, 15);
  console.log("    " + bv.map(([v, x]) => `${v}:${x.diff}/${x.n}`).join("  "));
}

// ---------------------------------------------------------------- convert

function convert(xmlPath: string, out?: string) {
  const { lbs, text } = readCbeta(xmlPath);
  const lines = lbs.map(lb => `${lb}\t${text.get(lb) ?? ""}`);
  let target = out;
  if (!target) {
    mkdirSync("cbeta-out", { recursive: true });
    target = "cbeta-out/" + xmlPath.replace(/^cbeta[\\/]/, "").replace(/[\\/]/g, "_").replace(/\.xml$/, ".tsv");
  }
  writeFileSync(target, lines.join("\n") + "\n");
  console.log(`【轉換】${xmlPath} → ${target}（${lbs.length} 行，SAT 格式：pcl<TAB>文字）`);
}

// ---------------------------------------------------------------- diff

function diff(volArg: string, noArg: string, juanArg?: string) {
  const vol = volArg.padStart(2, "0"), no = noArg.replace(/^0+/, "");
  const dir = join(CB, `T${vol}`);
  const files = readdirSync(dir).filter(f => new RegExp(`^T${vol}n0*${no}[a-z]?_`).test(f)).sort();
  const sat = readSat(`T${vol}`);
  let totSame = 0, totHanSame = 0, totDiff = 0, totOnlyCb = 0, totOnlySat = 0;
  for (const f of files) {
    const juan = Number(/_(\d{3})\.xml$/.exec(f)![1]);
    if (juanArg && Number(juanArg) !== juan) continue;
    const { lbs, text } = readCbeta(join(dir, f));
    console.log(`\n=== ${f}（CBETA ${lbs.length} 行）===`);
    const show: string[] = [];
    for (const lb of lbs) {
      const s = sat.get(lb);
      const c = text.get(lb) ?? "";
      if (s === undefined) { totOnlyCb++; show.push(`C ${lb} | （SAT 無）| ${c.slice(0, 40)}`); continue; }
      if (s === c) { totSame++; totHanSame++; continue; }
      if (hanOf(s) === hanOf(c)) { totHanSame++; continue; }   // 只差標點
      totDiff++;
      if (show.length < 25) show.push(`! ${lb} | ${s.slice(0, 38)} | ${c.slice(0, 38)}`);
    }
    for (const lb of sat.keys()) {
      if (!text.has(lb) && lbs.length && seq(lb) >= seq(lbs[0]) && seq(lb) <= seq(lbs[lbs.length - 1])) totOnlySat++;
    }
    console.log(show.slice(0, 25).join("\n"));
    if (show.length > 25) console.log(`  …另有 ${show.length - 25} 處`);
  }
  console.log(`\n【合計】完全相同 ${totSame}、只差標點 ${totHanSame - totSame}、文字不同 ${totDiff}、只有 CBETA 有 ${totOnlyCb}、只有 SAT 有 ${totOnlySat}`);
}

// ---------------------------------------------------------------- sample

function sample(p: string) {
  let xml = readFileSync(p, "utf-8");
  xml = xml.slice(xml.indexOf("<text>"));
  const tags = new Map<string, number>();
  for (const m of xml.matchAll(/<([a-zA-Z:]+)/g)) tags.set(m[1], (tags.get(m[1]) ?? 0) + 1);
  console.log(`【${p}】${(statSync(p).size / 1024).toFixed(0)} KB`);
  console.log("標籤：" + [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => `${k}(${v})`).join(" "));
  console.log("\n前 1800 字元：\n" + xml.slice(0, 1800).replace(/\t/g, ""));
}

// ---------------------------------------------------------------- 主流程

const [cmd, ...args] = process.argv.slice(2);
switch (cmd) {
  case "scan": scan(args[0]); break;
  case "convert": convert(args[0], args[1]); break;
  case "diff": diff(args[0], args[1], args[2]); break;
  case "sample": sample(args[0]); break;
  default:
    console.log(`用法：
  bun cbtool.ts scan [冊]              全藏掃描，逐卷比對卷界 → cbeta-sat-diff.tsv
  bun cbtool.ts convert <xml> [out]    單檔轉成 SAT 格式
  bun cbtool.ts diff <冊> <經號> [卷]  逐 lb 並列比對
  bun cbtool.ts sample <xml>           印出標籤結構樣本`);
}
