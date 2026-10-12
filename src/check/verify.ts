// verify.ts — 抽查單一卷的比對結果（用來檢查正文起點、序言／附文判定是否合理）
//
// 用法：
//   bun verify.ts 0001 0220 1        # 比對 K0001 卷1 與 T0220 卷1
//   bun verify.ts 0723 0128a 1
//
// 會印出兩藏該卷的漢字數、正文／序言／附文分布、正文起點 pcl，以及該處前後的文字。

import { openDb, buildGoryeoIndex, buildTaishoIndex, readJuan, pclAt, normSutra } from "../core/juanindex";
import { compareHanzi } from "../core/similarity";

const [kArg, tArg, jArg] = process.argv.slice(2);
if (!kArg || !tArg) {
  console.log("用法: bun verify.ts <高麗經號> <大正經號> [卷號=1]");
  process.exit(1);
}
const juan = Number(jArg ?? 1);

const kdb = openDb("K.db"), tdb = openDb("T.db");
const kIdx = buildGoryeoIndex(kdb);
const tIdx = buildTaishoIndex(tdb);

const k = normSutra(kArg), t = normSutra(tArg).toUpperCase();
const kS = kIdx.get(k), tS = tIdx.get(t);
if (!kS) { console.error(`K.db 無 K${k}`); process.exit(1); }
if (!tS) { console.error(`T.db 無 T${t}`); process.exit(1); }

const kRec = kS.juan.find(x => x.juan === juan);
const tRec = tS.juan.find(x => x.juan === juan);
if (!kRec) { console.error(`K${k} 無第 ${juan} 卷（共 ${kS.juanCount} 卷）`); process.exit(1); }
if (!tRec) { console.error(`T${t} 無第 ${juan} 卷（共 ${tS.juanCount} 卷）`); process.exit(1); }

const kt = readJuan(kdb, kRec), tt = readJuan(tdb, tRec);
const d = compareHanzi(kt.hanzi, tt.hanzi);
const cut = (s: string, a: number, b: number) => (a >= b ? "" : s.slice(a, b));

console.log(`K${k} 卷${juan}  vol ${kRec.vol} ${kRec.start_pcl}-${kRec.end_pcl}  ${kt.hanzi.length} 漢字`);
console.log(`T${t} 卷${juan}  vol ${tRec.vol} ${tRec.start_pcl}-${tRec.end_pcl}  ${tt.hanzi.length} 漢字`);
console.log("");
console.log(`相同 ${d.matched}  替代 ${d.substituted}  新增 ${d.inserted}  刪除 ${d.deleted}`);
console.log(`相似度 ${d.similarity.toFixed(6)}   嚴格相似度 ${d.strictSimilarity.toFixed(6)}`);
console.log(`序言 K${d.preA} / T${d.preB}      正文 K${d.bodyA} / T${d.bodyB}      附文 K${d.postA} / T${d.postB}`);
console.log(`正文起點 K ${pclAt(kt, d.bodyStartA)}    T ${pclAt(tt, d.bodyStartB)}`);
console.log("");
console.log(`K 卷首 60 字 : ${cut(kt.hanzi, 0, 60)}`);
console.log(`T 卷首 60 字 : ${cut(tt.hanzi, 0, 60)}`);
console.log(`K 正文起點前 30 字: …${cut(kt.hanzi, d.bodyStartA - 30, d.bodyStartA)}`);
console.log(`T 正文起點前 30 字: …${cut(tt.hanzi, d.bodyStartB - 30, d.bodyStartB)}`);
console.log(`K 正文首 60 字: ${cut(kt.hanzi, d.bodyStartA, d.bodyStartA + 60)}`);
console.log(`T 正文首 60 字: ${cut(tt.hanzi, d.bodyStartB, d.bodyStartB + 60)}`);
if (d.postA || d.postB) {
  console.log(`K 附文（${d.postA} 字）: ${cut(kt.hanzi, d.bodyEndA, d.bodyEndA + 80)}`);
  console.log(`T 附文（${d.postB} 字）: ${cut(tt.hanzi, d.bodyEndB, d.bodyEndB + 80)}`);
}
