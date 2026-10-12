// findtrunc.ts — 用大正藏判斷高麗藏哪一卷「真的被截斷」
//
// 判準：把 T 的正文與 K 的正文對齊後，看 T 這邊「沒有 K 對應」的字落在哪裡。
//   ・落在結尾一大段 → K 被截斷（要補抓）
//   ・散落各處或落在中間 → 版本差異（例如《釋迦譜》中間插了十卷本），不必抓
//
// 用法：bun findtrunc.ts [--min 300]   → goryeo-trunc.tsv

import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { openDb, buildGoryeoIndex, buildTaishoIndex, readJuan } from "../core/juanindex";
import { compareHanzi, myersDiff } from "../core/similarity";

const argv = process.argv.slice(2);
const flag = (n: string, d: number) => { const i = argv.indexOf(n); return i >= 0 ? Number(argv[i + 1]) : d; };
const MIN_TAIL = flag("--min", 300);        // 結尾缺字超過這個數才當作截斷
const CHAR_PER_COL = 330;                   // 一欄大約多少漢字（用來估要抓幾欄）

const KDB = (() => { const i = argv.indexOf("--kdb"); return i >= 0 ? argv[i + 1] : "K.db"; })();
const kdb = openDb(KDB), tdb = openDb("T.db");
const kIdx = buildGoryeoIndex(kdb, () => {}), tIdx = buildTaishoIndex(tdb);
const kj = new Database(KDB, { readonly: true });

const rows: { ks: string; ts: string; j: number; vol: number; end: string; tail: number; cols: number; ins: number }[] = [];
let n = 0;
for (const line of readFileSync("tables/comparejuan.tsv", "utf-8").split(/\r?\n/)) {
  const c = line.split("\t");
  if (c.length < 13 || c[0] === "高麗經號") continue;
  const ks = c[0], ts = c[1], j = Number(c[2]);
  const ins = Number(c[8]), sim = Number(c[4]);
  if (!(ins >= 500 && sim < 0.995)) continue;          // 先粗篩：T 多出不少字且相似度偏低
  const kRec = kIdx.get(ks)?.juan.find(x => x.juan === j);
  const tRec = tIdx.get(ts)?.juan.find(x => x.juan === j);
  if (!kRec || !tRec) continue;
  const kt = readJuan(kdb, kRec), tt = readJuan(tdb, tRec);
  const segs = myersDiff(kt.hanzi, tt.hanzi);
  const d = compareHanzi(kt.hanzi, tt.hanzi, segs);
  // T 正文中，最後一個有 K 對應（相同或替代配對）的位置
  let lastAligned = d.bodyStartB;
  for (const sg of segs) {
    if (sg.t === "=") { if (sg.bStart + sg.len <= d.bodyEndB) lastAligned = Math.max(lastAligned, sg.bStart + sg.len); }
    else if (sg.t === "-") { /* 配對成替代的由下方補 */ }
  }
  // 替代段（刪+增成對）也算對齊過
  let i = 0;
  while (i < segs.length) {
    if (segs[i].t === "=") { i++; continue; }
    let d0 = -1, dl = 0, i0 = -1, il = 0;
    while (i < segs.length && segs[i].t !== "=") {
      const g = segs[i];
      if (g.t === "-") { if (d0 < 0) d0 = g.aStart; dl += g.len; } else { if (i0 < 0) i0 = g.bStart; il += g.len; }
      i++;
    }
    const pair = Math.min(dl, il);
    if (pair > 0 && i0 + pair <= d.bodyEndB) lastAligned = Math.max(lastAligned, i0 + pair);
  }
  const tail = d.bodyEndB - lastAligned;
  n++;
  if (tail >= MIN_TAIL) {
    const cols = Math.ceil(tail / CHAR_PER_COL) + 1;
    rows.push({ ks, ts, j, vol: kRec.vol, end: kRec.end_pcl, tail, cols, ins });
  }
}
kdb.close(); tdb.close(); kj.close();

rows.sort((a, b) => b.tail - a.tail);
console.log(`粗篩 ${n} 卷（新增≥500、相似度<0.995）；其中結尾缺字 ≥${MIN_TAIL} 者 ${rows.length} 卷`);
const total = rows.reduce((s, r) => s + r.cols, 0);
console.log(`估計需補抓 ${total} 欄（＝約 ${total} 次請求）\n`);
console.log("  高麗經 大正經 卷  冊  終點     結尾缺字  估欄數");
for (const r of rows.slice(0, 25))
  console.log(`  ${r.ks.padStart(4)}  ${r.ts.padStart(4)}  ${String(r.j).padStart(4)}  ${String(r.vol).padStart(2)}  ${r.end}  ${String(r.tail).padStart(7)}  ${String(r.cols).padStart(5)}`);

const out = ["經號\t大正經號\t卷\t冊\t終點\t結尾缺字\t估欄數\t新增字數",
  ...rows.map(r => [r.ks, r.ts, r.j, r.vol, r.end, r.tail, r.cols, r.ins].join("\t"))];
require("fs").writeFileSync("tables/goryeo-trunc.tsv", out.join("\n") + "\n");
console.log("\n→ goryeo-trunc.tsv");
