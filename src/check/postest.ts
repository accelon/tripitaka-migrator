// postest.ts — 位置轉換的獨立驗證批次
//
// 做法：從 posmap.db 取每一個對照卷，在卷內挑分散的位置，做 T→K 轉換，
// 再用**字元位移**回到 K.db / T.db 的正文裡取同一段文字比對。
// 驗證不依賴 posmap.db 自己的紀錄。
//
// 抽樣：每一部經取「第一卷 40% 處」與「最後一卷 60% 處」各一點，
// 1474 部經各出 1–2 點，沒有任何一部經佔比超過 0.1%。
//
// 內建自我檢查：對齊幾何（lineStart）算出來的字，必須與資料庫該行的第一個漢字相同；
// 不一致代表幾何與資料庫文字對不上，這種案例單獨統計，不混進通過率。
//
// 用法：bun postest.ts [--out postest-cases.tsv] [--win 8] [--thr 0.7]

import { openPosSource, listTsutras, listJuans } from "../core/posdb";
import { convertTaishoGoryeo, convertGoryeoTaisho, lineIndexAt, findLine, type AlignRec } from "../core/posmap";
import { openDb, readJuan, buildGoryeoIndex, buildTaishoIndex, hanOnly } from "../core/juanindex";
import { pclOfSeq, seqOfPcl, type Address } from "../core/posfmt";
import { writeFileSync } from "fs";

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const OUT = flag("--out", "postest-cases.tsv")!;
const WIN = Number(flag("--win", "8"));
const THR = Number(flag("--thr", "0.7"));
const SLACK = 8;
const t0 = Date.now();

const kdb = openDb("K.db"), tdb = openDb("T.db");
const kIdx = buildGoryeoIndex(kdb, () => {}), tIdx = buildTaishoIndex(tdb);
const posdb = openPosSource("posmap.db");
const qT = tdb.query("SELECT text FROM lines WHERE vol=? AND seq=? LIMIT 1");

const juanHanzi = (db: any, rec: any): string => {
  const r: any = readJuan(db, rec);
  return typeof r === "string" ? r : (r.hanzi ?? "");
};
const geoOff = (g: any, pcl: string, off: number): number => {
  const s = seqOfPcl(pcl);
  if (s === null) return -1;
  const [li] = findLine(g, s);
  return g.lineStart[li] + off;
};
/** 增補平面字（如 𤦲、𦼇）在 UTF-16 佔兩個單位，會讓逐字比較整段錯位，先移除 */
const strip = (s: string) => s.replace(/[\u{10000}-\u{10FFFF}]/gu, "");
/** 異體字正規化：兩邊字形不同但同一個字（高麗藏與大正藏的常見對）
 *  這張表就是先前從 cbeta-sat-chars.tsv 得到的字形對 */
const PAIRS: [string, string][] = [["說","説"],["為","爲"],["眾","衆"],["緣","縁"],["德","徳"],["內","内"],["脫","脱"],
  ["增","増"],["俱","倶"],["真","眞"],["虛","虚"],["舉","擧"],["喻","喩"],["剎","刹"],["繫","繋"],["讚","讃"],
  ["錄","録"],["衛","衞"],["歲","歳"],["清","淸"],["即","卽"],["陀","陁"],["寶","寳"],["淨","凈"],["眾","衆"]];
const CANON = new Map<string, string>();
for (const [a, b] of PAIRS) { CANON.set(a, a); CANON.set(b, a); }
const norm = (s: string) => Array.from(strip(s)).map(c => CANON.get(c) ?? c);
/** 最長共同子序列佔較短視窗的比例：對插入、刪除、異體字都寬容，但要求順序一致 */
const lcs = (A: string[], B: string[]) => {
  const dp: number[][] = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = 1; i <= A.length; i++) for (let j = 1; j <= B.length; j++)
    dp[i][j] = A[i - 1] === B[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[A.length][B.length];
};
const bestSim = (a: string, b: string, _range: number) => {
  const A = norm(a), B = norm(b);
  const n = Math.min(A.length, B.length);
  return n ? lcs(A, B) / n : 0;
};

// ---------------------------------------------------------------- 抽樣
interface Case { ts: string; tj: number; ks: string; kj: number; rec: AlignRec; addr: Address }
const cases: Case[] = [];
const tsutras = listTsutras(posdb.db);
for (const ts of tsutras) {
  const juans = listJuans(posdb.db, ts);
  if (!juans.length) continue;
  const picks = juans.length === 1 ? [juans[0]] : [juans[0], juans[juans.length - 1]];
  for (let k = 0; k < picks.length; k++) {
    const rec = posdb.source.align(ts, picks[k].tjuan);
    if (!rec) continue;
    const len = rec.tBody[1] - rec.tBody[0];
    if (len < 2 * WIN + 4) continue;
    const x = Math.round(rec.tBody[0] + (k === 0 ? 0.4 : 0.6) * len);
    const li = lineIndexAt(rec.t, x);
    const pc = pclOfSeq(rec.t.lineSeq[li]);
    cases.push({
      ts, tj: rec.tjuan, ks: rec.ksutra, kj: rec.kjuan, rec,
      addr: { side: "T", vol: rec.t.vol, page: pc.page, col: pc.col, line: pc.line, off: x - rec.t.lineStart[li] },
    });
  }
}
console.log(`【抽樣】${cases.length} 個位置，來自 ${tsutras.length} 部經（每部 ${(cases.length / tsutras.length).toFixed(2)} 點）`);

// ---------------------------------------------------------------- 驗證
const rows: string[] = ["#\t大正經\t卷\t大正位置\t大正文字\t高麗經\t卷\t高麗位置\t高麗文字\texact\t相似度\t判定\t回程"];
let pass = 0, fail = 0, geomBad = 0, noRec = 0, inexact = 0, rtPass = 0, rtFail = 0;
const fails: string[] = [], geoms: string[] = [];

for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  const res = convertTaishoGoryeo(c.rec, c.addr);
  if (!res.ok) { noRec++; continue; }
  const tRec = tIdx.get(c.ts)?.juan.find((x: any) => x.juan === c.tj);
  const kRec = kIdx.get(c.ks)?.juan.find((x: any) => x.juan === c.kj);
  if (!tRec || !kRec) { noRec++; continue; }

  const tSeq = seqOfPcl(res.tPcl), kSeq = seqOfPcl(res.kPcl);
  if (tSeq === null || kSeq === null) { noRec++; continue; }
  const tHan = juanHanzi(tdb, tRec), kHan = juanHanzi(kdb, kRec);
  const x = geoOff(c.rec.t, res.tPcl, res.tOff);
  const y = geoOff(c.rec.k, res.kPcl, res.kOff);

  // 自我檢查：幾何位移處的字，應等於資料庫該行的第一個漢字
  const tLi = findLine(c.rec.t, tSeq)[0];
  const tGeoFirst = tHan.slice(c.rec.t.lineStart[tLi], c.rec.t.lineStart[tLi] + 1);
  const tDbFirst = hanOnly((qT.get(c.rec.t.vol, tSeq) as any)?.text ?? "").slice(0, 1);
  if (tGeoFirst && tDbFirst && tGeoFirst !== tDbFirst) {
    geomBad++;
    if (geoms.length < 6) geoms.push(`T${c.ts}/${c.tj} ${res.tPcl}：幾何「${tGeoFirst}」 vs T.db「${tDbFirst}」`);
    continue;
  }

  const W = Math.max(4, Math.min(WIN, Math.max(0, x - c.rec.tBody[0]), Math.max(0, y - c.rec.kBody[0])));
  const tWin = tHan.slice(Math.max(0, x - W), x + W + 1);
  const kWin = kHan.slice(Math.max(0, y - W), y + W + 1);
  const sim = bestSim(tWin, kWin, SLACK);
  const ok = sim >= THR;
  if (ok) pass++; else { fail++; if (fails.length < 8) fails.push(`T${c.ts}/${c.tj} ${res.input} → K${c.ks}/${c.kj} ${res.koryo}\n     T「${tWin.slice(0, 36)}」\n     K「${kWin.slice(0, 36)}」  相似度 ${sim.toFixed(2)}`); }
  if (!res.exact) inexact++;

  const back = convertGoryeoTaisho(c.rec, res.koryo);
  let rt = "—";
  if (back.ok) { const same = back.tPcl === res.tPcl; rt = same ? "✓" : "≈"; if (same) rtPass++; else rtFail++; }

  rows.push([i, c.ts, c.tj, `${res.tPcl}.${res.tOff}`, tWin.slice(0, 30), c.ks, c.kj, `${res.kPcl}.${res.kOff}`,
    kWin.slice(0, 30), res.exact ? "1" : "0", sim.toFixed(3), ok ? "✓" : "✗", rt].join("\t"));
}
writeFileSync(OUT, rows.join("\n") + "\n");

const tested = pass + fail;
const secs = (Date.now() - t0) / 1000;
console.log(`\n【結果】（用字元位移比對，空行不計）`);
console.log(`  通過 ${pass.toLocaleString()} / ${tested.toLocaleString()}（${tested ? (pass / tested * 100).toFixed(2) : "-"}%）`);
console.log(`  失敗 ${fail}、幾何與資料庫不符 ${geomBad}、缺卷資料 ${noRec}、非 1:1 對應段 ${inexact}`);
console.log(`  回程（K→T 回到同一行）一致 ${rtPass.toLocaleString()}、不同行 ${rtFail}`);
console.log(`  耗時 ${secs.toFixed(1)} 秒 → ${(cases.length / secs).toFixed(0)} 位置/秒`);
if (geoms.length) { console.log(`\n  幾何不符樣本：`); geoms.forEach(g => console.log("   " + g)); }
if (fails.length) { console.log(`\n  失敗樣本：`); fails.forEach(f => console.log("   " + f)); }
console.log(`\n→ ${OUT}`);
posdb.close(); kdb.close(); tdb.close();
