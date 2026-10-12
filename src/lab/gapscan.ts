// gapscan.ts — 盤點 goryeo-raw-html（＝K.db）相對於 juaninfo 應有範圍的缺漏
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";

const db = new Database("K.db", { readonly: true });
const cols = "abc";

// 實際有的 (vol,page,col)
const have = new Set<string>();
for (const r of db.query("SELECT DISTINCT vol, page, col FROM lines").all() as any[]) {
  have.add(`${r.vol}_${r.page}_${r.col}`);
}
console.log(`實際欄數：${have.size}`);

// 各冊的頁碼分佈（找整頁缺號）
const pages = new Map<number, Set<number>>();
for (const r of db.query("SELECT DISTINCT vol, page FROM lines").all() as any[]) {
  if (!pages.has(r.vol)) pages.set(r.vol, new Set());
  pages.get(r.vol)!.add(r.page);
}
let gapPages = 0;
const gapByVol = new Map<number, number[]>();
for (const [vol, ps] of [...pages].sort((a, b) => a[0] - b[0])) {
  const sorted = [...ps].sort((a, b) => a - b);
  const missing: number[] = [];
  for (let p = sorted[0]; p <= sorted[sorted.length - 1]; p++) if (!ps.has(p)) missing.push(p);
  if (missing.length) { gapByVol.set(vol, missing); gapPages += missing.length; }
}
console.log(`整頁缺號：${gapPages} 頁，分佈 ${gapByVol.size} 冊`);

// juaninfo：逐卷比對「應有欄」與「實有欄」
const ji: { sutra: string; vol: number; juan: number; start: string; end: string }[] = [];
for (const line of readFileSync("k-txt/juaninfo.tsv", "utf-8").split(/\r?\n/)) {
  const c = line.split("\t");
  if (c.length < 6 || !/^\d/.test(c[0])) continue;
  ji.push({ sutra: c[0], vol: Number(c[1]), juan: Number(c[3]), start: c[4], end: c[5] });
}
console.log(`juaninfo 卷數：${ji.length}`);

const seqOf = (pcl: string) => {
  const m = /^(\d{4})([a-g])(\d{2})$/.exec(pcl);
  return m ? Number(m[1]) * 1000 + (m[2].charCodeAt(0) - 97) * 100 + Number(m[3]) : -1;
};
const pclOf = (s: number) => { const r = s % 1000; return String((s - r) / 1000).padStart(4, "0") + cols[Math.floor(r / 100)] + String(r % 100).padStart(2, "0"); };

// 以「頁」為單位：某卷範圍內的每一頁，只要完全沒有任何欄，就是缺
const missBySutra = new Map<string, { juan: number; pages: number[] }[]>();
let missTotal = 0;
for (const j of ji) {
  const a = seqOf(j.start), b = seqOf(j.end);
  if (a < 0 || b < 0) continue;
  const p0 = Math.floor(a / 1000), p1 = Math.floor(b / 1000);
  const miss: number[] = [];
  for (let p = p0; p <= p1; p++) {
    let any = false;
    for (const c of cols) if (have.has(`${j.vol}_${p}_${c}`)) { any = true; break; }
    if (!any) miss.push(p);
  }
  if (miss.length) {
    missTotal += miss.length;
    if (!missBySutra.has(j.sutra)) missBySutra.set(j.sutra, []);
    missBySutra.get(j.sutra)!.push({ juan: j.juan, pages: miss });
  }
}
console.log(`\n卷範圍內完全沒有內容的頁：${missTotal} 頁，涉及 ${missBySutra.size} 部經`);
const top = [...missBySutra.entries()].sort((a, b) => b[1].reduce((x, y) => x + y.pages.length, 0) - a[1].reduce((x, y) => x + y.pages.length, 0)).slice(0, 15);
for (const [s, list] of top) {
  const n = list.reduce((x, y) => x + y.pages.length, 0);
  console.log(`  K${s}: ${n} 頁  ` + list.slice(0, 4).map(x => `卷${x.juan}[${x.pages.slice(0, 6).join(",")}${x.pages.length > 6 ? "…" : ""}]`).join(" "));
}
db.close();
