// comparejuan.ts — 任務 2：逐卷比對高麗藏與大正藏的經文
//
// 用法：
//   bun comparejuan.ts              # 續跑（comparejuan.tsv 已完成的卷會跳過）
//   bun comparejuan.ts --fresh      # 從頭重跑，覆蓋 comparejuan.tsv
//   bun comparejuan.ts --limit 200  # 只跑 200 卷（測試用）
//
// 比對範圍：對照表為一對一、且兩藏卷數相同的高麗藏經典，逐卷比對。
// 輸出：逐卷 append 到 comparejuan.tsv，欄位如下（前 8 欄為 juanmap.md 指定）。
//
//   高麗經號  大正經號  卷數  漢字數  相似度  正文字數  序言字數  附文字數
//   新增字數  刪除字數  替代字數  嚴格相似度  大正漢字數  正文起點K  正文起點T  備註
//
//   漢字數／正文字數：皆指高麗藏該卷（漢字＝已剔除標點、標記、數字、ASCII）。
//   相似度：(相同+替代)/對齊長度，只計正文；替代視為非差異（見 juanmap.md 約束 3）。
//   嚴格相似度：相同/對齊長度（替代也算差異），供對照。
//   序言字數／附文字數：帶正負號的整數，正號表示高麗藏沒有、大正藏有的字數；
//                       負號表示高麗藏有、而被大正藏刪去的字數；0 顯示為 0。

import { openSync, writeSync, closeSync, existsSync, readFileSync } from "fs";
import { openDb, buildGoryeoIndex, buildTaishoIndex, loadMapping, readJuan, pclAt, normSutra, detectBoundaryIssues } from "../core/juanindex";
import { compareHanzi } from "../core/similarity";

const KDB = process.env.KDB ?? "K.db";
const TDB = process.env.TDB ?? "T.db";
const OUT = process.env.OUT ?? "comparejuan.tsv";
const FRESH = process.argv.includes("--fresh");
const li = process.argv.indexOf("--limit");
const LIMIT = li >= 0 ? Number(process.argv[li + 1]) : Infinity;

const HEAD = [
  "高麗經號", "大正經號", "卷數", "漢字數", "相似度", "正文字數", "序言字數", "附文字數",
  "新增字數", "刪除字數", "替代字數", "嚴格相似度", "大正漢字數", "正文起點K", "正文起點T", "備註",
];

/** 帶正負號的整數：+0 / -0 一律顯示 0 */
const signed = (n: number) => (n === 0 ? "0" : n > 0 ? `+${n}` : String(n));

// ---------------------------------------------------------------- 準備

const t0 = Date.now();
const kdb = openDb(KDB);
const tdb = openDb(TDB);
console.log(`[索引] 建立 K.db 卷索引…`);
const kIdx = buildGoryeoIndex(kdb, msg => console.log(`[索引] ${msg}`));
const tIdx = buildTaishoIndex(tdb);
const mapping = loadMapping();
console.log(`[索引] T 卷索引：${tIdx.size} 部經；對照表 ${mapping.size} 筆`);
const kBounds = detectBoundaryIssues(kdb, kIdx);
const tBounds = detectBoundaryIssues(tdb, tIdx);
console.log(`[索引] 卷界與刻本不符：K ${kBounds.size} 卷、T ${tBounds.size} 卷（將標注於備註）`);

/** 挑出可比對的 (高麗經, 大正經) 配對：一對一且卷數相同 */
const pairs: { k: string; t: string; n: number }[] = [];
for (const [k, ki] of [...kIdx].sort((a, b) => a[0].localeCompare(b[0]))) {
  const m = mapping.get(k);
  if (!m || m.kind !== "exact") continue;
  const ti = tIdx.get(normSutra(m.target!).toUpperCase());
  if (!ti || ti.juanCount !== ki.juanCount) continue;
  pairs.push({ k, t: m.target!, n: ki.juanCount });
}
const totalJuan = pairs.reduce((a, p) => a + p.n, 0);
console.log(`[範圍] ${pairs.length} 部經、共 ${totalJuan} 卷待比對`);

// ---------------------------------------------------------------- 輸出檔與續跑

const seen = new Set<string>();
let fd: number;
if (!FRESH && existsSync(OUT)) {
  const txt = readFileSync(OUT, "utf-8");
  for (const line of txt.split(/\r?\n/)) {
    if (!line || line.startsWith("高麗經號")) continue;
    const c = line.split("\t");
    if (c.length >= 3) seen.add(`${c[0]}\t${c[2]}`);
  }
  fd = openSync(OUT, "a");
  console.log(`[續跑] ${OUT} 已有 ${seen.size} 卷結果，將跳過`);
} else {
  fd = openSync(OUT, "w");
  writeSync(fd, HEAD.join("\t") + "\n");
  console.log(`[輸出] 寫入 ${OUT}`);
}

let buf: string[] = [];
let lastFlush = Date.now();
const flush = () => {
  if (buf.length === 0) return;
  writeSync(fd, buf.join(""));
  buf = [];
  lastFlush = Date.now();
};
const emit = (row: string) => {
  buf.push(row + "\n");
  if (buf.length >= 20 || Date.now() - lastFlush > 2000) flush();
};

let stop = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stop) process.exit(1);
    stop = true;
    flush();
    console.log(`\n[中斷] 已將緩衝寫入 ${OUT}；再次 Ctrl-C 強制結束。`);
  });
}

// ---------------------------------------------------------------- 主迴圈

let done = 0, compared = 0, skipped = 0, coarse = 0;
let sumSim = 0;
const warnings: string[] = [];

for (const p of pairs) {
  const ki = kIdx.get(p.k)!;
  const ti = tIdx.get(normSutra(p.t).toUpperCase())!;
  for (let i = 0; i < ki.juan.length; i++) {
    if (stop) break;
    const kRec = ki.juan[i];
    // 以大正藏同一卷號配對
    const tRec = ti.juan.find(j => j.juan === kRec.juan) ?? ti.juan[i];
    if (seen.has(`${p.k}\t${kRec.juan}`)) { skipped++; continue; }
    if (compared >= LIMIT) { stop = true; break; }

    const kt = readJuan(kdb, kRec);
    const tt = readJuan(tdb, tRec);
    const d = compareHanzi(kt.hanzi, tt.hanzi);
    compared++; done++;
    sumSim += d.similarity;
    if (d.coarse) coarse++;

    const notes: string[] = [];
    const kb = kBounds.get(`${p.k}/${kRec.juan}`);
    const tb = tBounds.get(`${p.t.toUpperCase()}/${tRec.juan}`);
    if (kb) notes.push(`高麗卷界存疑（${kb}）`);
    if (tb) notes.push(`大正卷界存疑（${tb}）`);
    if (d.coarse) notes.push("對齊粗略（可能是錯配或文字差異極大）");
    const lo = Math.min(d.hanA, d.hanB), hi = Math.max(d.hanA, d.hanB);
    if (hi > 0 && lo / hi < 0.8) notes.push(`兩藏字數懸殊（${lo}/${hi}）`);
    if (kRec.juan !== tRec.juan) notes.push(`卷號不對齊（K${kRec.juan} vs T${tRec.juan}）`);
    if (notes.length) warnings.push(`K${p.k}/${kRec.juan} T${p.t}/${tRec.juan}：${notes.join("；")}`);

    emit([
      p.k, p.t, kRec.juan, d.hanA,
      d.similarity.toFixed(6), d.bodyA, signed(d.preB - d.preA), signed(d.postB - d.postA),
      d.inserted, d.deleted, d.substituted,
      d.strictSimilarity.toFixed(6), d.hanB,
      pclAt(kt, d.bodyStartA), pclAt(tt, d.bodyStartB),
      notes.join("；"),
    ].join("\t"));

    if (compared % 200 === 0) {
      flush();
      const el = (Date.now() - t0) / 1000;
      const rate = compared / el;
      const left = totalJuan - seen.size - compared;
      console.log(`[進度] ${compared} 卷（跳過 ${skipped}） ${el.toFixed(0)}s  ${rate.toFixed(1)} 卷/秒  預估剩餘 ${(left / rate / 60).toFixed(1)} 分`);
    }
  }
  if (stop) break;
}

flush();
closeSync(fd);

const el = (Date.now() - t0) / 1000;
console.log(`\n[完成] 本次比對 ${compared} 卷，跳過 ${skipped} 卷，耗時 ${el.toFixed(1)}s`);
if (compared) console.log(`[統計] 平均相似度 ${(sumSim / compared).toFixed(6)}；粗略對齊 ${coarse} 卷`);
if (warnings.length) {
  console.log(`[警告] ${warnings.length} 卷有異常，前 20 筆：`);
  warnings.slice(0, 20).forEach(w => console.log("   " + w));
  console.log(`   …完整清單見 ${OUT} 的「備註」欄`);
}
