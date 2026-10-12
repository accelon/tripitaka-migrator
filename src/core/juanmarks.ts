// juanmarks.ts — 輸出每卷的序言起點（juan-prolog.tsv）與附文起點（juan-epilog.tsv）
//
// 用法：
//   bun juanmarks.ts              # 續跑（已完成的卷會跳過）
//   bun juanmarks.ts --fresh      # 從頭重跑，覆蓋兩個檔案
//   bun juanmarks.ts --limit 200  # 只跑 200 卷（測試）
//
// 範圍與 comparejuan.ts 完全一致（對照表一對一且卷數相同的 1475 部經、6360 卷），
// 因此兩個檔案可與 comparejuan.tsv 逐列對應。
//
// 定義（與 similarity.ts 的分段一致）：
//   序言 = 該卷開頭、在兩藏之間「只出現在單邊」的那一段；之後才是正文。
//          序言起點通常是該卷第一個漢字；序言終點＝正文起點。
//   附文 = 正文結束之後、只出現在單邊的那一段（如高麗藏的「戊戌歲高麗國大藏都監奉勅雕造」刊記）。
//   起點／終點皆為頁行碼 pcl；該卷若無序言（或無附文），欄位填 -。
//   類型：無 / 卷首題記（卷末題記）/ 序言（附文）。
//         序言（附文）的條件是該區段兩藏幾乎不重疊（相同字數 < 該區最大長度的一半）
//         且長度達 100 字；否則只是經名、譯者、品名或卷末卷題這類題記。

import { openSync, writeSync, closeSync, existsSync, readFileSync } from "fs";
import { openDb, buildGoryeoIndex, buildTaishoIndex, loadMapping, readJuan, pclAt, normSutra, detectBoundaryIssues } from "./juanindex";
import { compareHanzi } from "./similarity";

const KDB = process.env.KDB ?? "K.db";
const TDB = process.env.TDB ?? "T.db";
const PROLOG = "tables/juan-prolog.tsv";
const EPILOG = "tables/juan-epilog.tsv";
const FRESH = process.argv.includes("--fresh");
const li = process.argv.indexOf("--limit");
const LIMIT = li >= 0 ? Number(process.argv[li + 1]) : Infinity;

/** 單邊差異達到此字數、且該區段內兩藏幾乎不重疊，才視為真正的序言／附文 */
const REAL_MARK = 100;

/**
 * 判定類型。
 * 只看長度不夠：兩藏若在該區段高度重疊（只有異體字之差），那其實是被分段邊界
 * 吸收進來的正文或卷首／卷末題記，不是序言／附文。
 */
function classify(lenA: number, lenB: number, matchedRegion: number, realTag: string, noteTag: string): string {
  const max = Math.max(lenA, lenB);
  if (max === 0) return "無";
  if (max >= REAL_MARK && matchedRegion < 0.5 * max) return realTag;
  return noteTag;
}

const PROLOG_HEAD = [
  "高麗經號", "大正經號", "卷數",
  "高麗序言起點", "高麗序言終點", "高麗序言字數",
  "大正序言起點", "大正序言終點", "大正序言字數",
  "類型", "備註",
];
const EPILOG_HEAD = [
  "高麗經號", "大正經號", "卷數",
  "高麗附文起點", "高麗附文終點", "高麗附文字數",
  "大正附文起點", "大正附文終點", "大正附文字數",
  "類型", "備註",
];

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
console.log(`[索引] 卷界與刻本不符：K ${kBounds.size} 卷、T ${tBounds.size} 卷`);

const pairs: { k: string; t: string; n: number }[] = [];
for (const [k, ki] of [...kIdx].sort((a, b) => a[0].localeCompare(b[0]))) {
  const m = mapping.get(k);
  if (!m || m.kind !== "exact") continue;
  const ti = tIdx.get(normSutra(m.target!).toUpperCase());
  if (!ti || ti.juanCount !== ki.juanCount) continue;
  pairs.push({ k, t: m.target!, n: ki.juanCount });
}
const totalJuan = pairs.reduce((a, p) => a + p.n, 0);
console.log(`[範圍] ${pairs.length} 部經、共 ${totalJuan} 卷`);

// ---------------------------------------------------------------- 輸出（可續跑）

function openOut(path: string, head: string[]) {
  const seen = new Set<string>();
  let fd: number;
  if (!FRESH && existsSync(path)) {
    for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
      if (!line || line.startsWith("高麗經號")) continue;
      const c = line.split("\t");
      if (c.length >= 3) seen.add(`${c[0]}\t${c[2]}`);
    }
    fd = openSync(path, "a");
    console.log(`[續跑] ${path} 已有 ${seen.size} 卷，將跳過`);
  } else {
    fd = openSync(path, "w");
    writeSync(fd, head.join("\t") + "\n");
    console.log(`[輸出] 寫入 ${path}`);
  }
  return { fd, seen };
}

const pro = openOut(PROLOG, PROLOG_HEAD);
const epi = openOut(EPILOG, EPILOG_HEAD);

const buf: Record<"p" | "e", string[]> = { p: [], e: [] };
let lastFlush = Date.now();
const flush = () => {
  if (buf.p.length) { writeSync(pro.fd, buf.p.join("")); buf.p = []; }
  if (buf.e.length) { writeSync(epi.fd, buf.e.join("")); buf.e = []; }
  lastFlush = Date.now();
};
const emit = (which: "p" | "e", row: string) => {
  buf[which].push(row + "\n");
  if (buf[which].length >= 20 || Date.now() - lastFlush > 2000) flush();
};

let stop = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stop) process.exit(1);
    stop = true;
    flush();
    console.log(`\n[中斷] 緩衝已寫入 ${PROLOG} / ${EPILOG}；再次 Ctrl-C 強制結束。`);
  });
}

// ---------------------------------------------------------------- 主迴圈

const DASH = "-";
let done = 0, prologCount = 0, epilogCount = 0, realProlog = 0;
const notes = (k: string, kj: number, t: string, tj: number): string => {
  const out: string[] = [];
  const kb = kBounds.get(`${k}/${kj}`), tb = tBounds.get(`${t.toUpperCase()}/${tj}`);
  if (kb) out.push(`高麗${kb}`);
  if (tb) out.push(`大正${tb}`);
  return out.join("；");
};

for (const p of pairs) {
  const ki = kIdx.get(p.k)!;
  const ti = tIdx.get(normSutra(p.t).toUpperCase())!;
  for (let i = 0; i < ki.juan.length; i++) {
    if (stop) break;
    const kRec = ki.juan[i];
    const tRec = ti.juan.find(j => j.juan === kRec.juan) ?? ti.juan[i];
    if (pro.seen.has(`${p.k}\t${kRec.juan}`) && epi.seen.has(`${p.k}\t${kRec.juan}`)) continue;
    if (done >= LIMIT) { stop = true; break; }

    const kt = readJuan(kdb, kRec);
    const tt = readJuan(tdb, tRec);
    const d = compareHanzi(kt.hanzi, tt.hanzi);
    done++;

    const note = notes(p.k, kRec.juan, p.t, tRec.juan);
    const kEnd = kt.hanzi.length, tEnd = tt.hanzi.length;

    // ---- 序言 ----
    if (!pro.seen.has(`${p.k}\t${kRec.juan}`)) {
      const kind = classify(d.preA, d.preB, d.matchedPre, "序言", "卷首題記");
      if (kind !== "無") prologCount++;
      if (kind === "序言") realProlog++;
      emit("p", [
        p.k, p.t, kRec.juan,
        d.preA > 0 ? pclAt(kt, 0) : DASH,
        d.preA > 0 ? pclAt(kt, d.bodyStartA - 1) : DASH,
        d.preA,
        d.preB > 0 ? pclAt(tt, 0) : DASH,
        d.preB > 0 ? pclAt(tt, d.bodyStartB - 1) : DASH,
        d.preB,
        kind, note,
      ].join("\t"));
    }

    // ---- 附文 ----
    if (!epi.seen.has(`${p.k}\t${kRec.juan}`)) {
      const kind = classify(d.postA, d.postB, d.matchedPost, "附文", "卷末題記");
      if (kind !== "無") epilogCount++;
      emit("e", [
        p.k, p.t, kRec.juan,
        d.postA > 0 ? pclAt(kt, d.bodyEndA) : DASH,
        d.postA > 0 ? pclAt(kt, kEnd - 1) : DASH,
        d.postA,
        d.postB > 0 ? pclAt(tt, d.bodyEndB) : DASH,
        d.postB > 0 ? pclAt(tt, tEnd - 1) : DASH,
        d.postB,
        kind, note,
      ].join("\t"));
    }

    if (done % 200 === 0) {
      flush();
      const el = (Date.now() - t0) / 1000;
      const rate = done / el;
      console.log(`[進度] ${done} 卷 ${el.toFixed(0)}s  ${rate.toFixed(1)} 卷/秒  預估剩餘 ${((totalJuan - done) / rate / 60).toFixed(1)} 分`);
    }
  }
  if (stop) break;
}

flush();
closeSync(pro.fd);
closeSync(epi.fd);

console.log(`\n[完成] 本次處理 ${done} 卷，耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`[序言] 卷首有序言或卷首題記 ${prologCount} 卷，其中判為真正序言 ${realProlog} 卷`);
console.log(`[附文] 卷末有附文或卷末題記 ${epilogCount} 卷`);
