// gapbig.ts — 只挑「間隔大於一頁」的卷界
//
// 卷與卷之間空幾行、乃至半頁，是刻本常態，不必補。
// 只有間隔大於一頁（>3 欄）才可能是整段漏抓。
import { readFileSync } from "fs";

const src = process.argv[2] ?? "_knew/juaninfo.tsv";
const THRESH = Number(process.argv[3] ?? 3);      // 幾欄以上才算異常

const colIdx = (c: string) => "abc".indexOf(c);
const colSeq = (pcl: string) => Number(pcl.slice(0, 4)) * 3 + colIdx(pcl[4]);

interface J { sutra: string; vol: number; juan: number; start: string; end: string; lines: number }
const byVol = new Map<number, J[]>();
for (const line of readFileSync(src, "utf-8").split(/\r?\n/)) {
  const c = line.split("\t");
  if (c.length < 7 || !/^\d/.test(c[0])) continue;
  const j: J = { sutra: c[0], vol: Number(c[1]), juan: Number(c[3]), start: c[4], end: c[5], lines: Number(c[6]) };
  if (!byVol.has(j.vol)) byVol.set(j.vol, []);
  byVol.get(j.vol)!.push(j);
}

const rows: { vol: number; sutra: string; juan: number; from: string; to: string; cols: number }[] = [];
for (const [vol, list] of byVol) {
  list.sort((a, b) => colSeq(a.start) - colSeq(b.start));
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    const cols = colSeq(b.start) - colSeq(a.end) - 1;
    if (cols >= THRESH) rows.push({ vol, sutra: a.sutra, juan: a.juan, from: a.end, to: b.start, cols });
  }
}
rows.sort((a, b) => b.cols - a.cols);
const total = rows.reduce((s, r) => s + r.cols, 0);
console.log(`【篩選】間隔 ≥ ${THRESH} 欄（＝1 頁）的卷界：${rows.length} 處，需補抓 ${total} 欄`);
const bySutra = new Map<string, number>();
for (const r of rows) bySutra.set(r.sutra, (bySutra.get(r.sutra) ?? 0) + r.cols);
console.log(`涉及 ${bySutra.size} 部經：` + [...bySutra].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([s, c]) => `K${s}:${c}`).join(" "));
console.log("\n最大的 20 處：");
console.log("  冊  經號 卷   終點     下一卷起點  間隔欄數");
for (const r of rows.slice(0, 20)) console.log(`  ${String(r.vol).padStart(2)}  ${r.sutra.padStart(4)}  ${String(r.juan).padStart(3)}  ${r.from}  ${r.to}   ${String(r.cols).padStart(4)}`);
if (process.argv.includes("--tsv")) {
  const out = ["冊\t經號\t卷\t終點\t下一卷起點\t間隔欄數", ...rows.map(r => [r.vol, r.sutra, r.juan, r.from, r.to, r.cols].join("\t"))];
  require("fs").writeFileSync("tables/goryeo-biggaps.tsv", out.join("\n") + "\n");
  console.log("\n→ goryeo-biggaps.tsv");
}
