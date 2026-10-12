// gapscan2.ts — 缺頁定位：每冊的缺頁在哪個經卷交界
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";

const db = new Database("K.db", { readonly: true });
const have = new Map<number, Set<number>>();
for (const r of db.query("SELECT DISTINCT vol, page FROM lines").all() as any[]) {
  if (!have.has(r.vol)) have.set(r.vol, new Set());
  have.get(r.vol)!.add(r.page);
}
// 各卷的起訖
const rows = db.query("SELECT sutra, vol, juan, start_pcl, end_pcl FROM juan ORDER BY vol, start_seq").all() as any[];
const byVol = new Map<number, any[]>();
for (const r of rows) { if (!byVol.has(r.vol)) byVol.set(r.vol, []); byVol.get(r.vol)!.push(r); }
db.close();

const pg = (pcl: string) => Number(pcl.slice(0, 4));
let total = 0;
const detail: string[] = [];
for (const [vol, list] of [...byVol].sort((a, b) => a[0] - b[0])) {
  const ps = have.get(vol); if (!ps) continue;
  const sorted = [...ps].sort((a, b) => a - b);
  const missing: number[] = [];
  for (let p = sorted[0]; p <= sorted[sorted.length - 1]; p++) if (!ps.has(p)) missing.push(p);
  if (!missing.length) continue;
  total += missing.length;
  for (const p of missing) {
    // 這一頁夾在哪兩卷之間
    const before = list.filter(r => pg(r.end_pcl) < p).pop();
    const after = list.find(r => pg(r.start_pcl) > p);
    detail.push(`${vol}\t${p}\t${before ? "K" + before.sutra + "/卷" + before.juan + " 迄 " + before.end_pcl : "-"}\t${after ? "K" + after.sutra + "/卷" + after.juan + " 起 " + after.start_pcl : "-"}`);
  }
}
console.log(`總缺頁 ${total}，分佈 ${new Set(detail.map(d => d.split("\t")[0])).size} 冊\n`);
const byV = new Map<string, string[]>();
for (const d of detail) { const v = d.split("\t")[0]; if (!byV.has(v)) byV.set(v, []); byV.get(v)!.push(d); }
for (const [v, list] of byV) {
  console.log(`第 ${v} 冊：缺 ${list.length} 頁`);
  for (const d of list.slice(0, 6)) {
    const c = d.split("\t");
    console.log(`   頁 ${c[1]}   前：${c[2]}   後：${c[3]}`);
  }
  if (list.length > 6) console.log(`   …另有 ${list.length - 6} 頁`);
}
