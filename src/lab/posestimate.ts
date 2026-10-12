// posestimate.ts — 估算全庫（1475 部經 / 6360 卷）位置對照檔的體積
//
//   bun posestimate.ts [抽樣間隔，預設 4]
//
// 作法：系統抽樣（每 N 部經取一部）建一個臨時 posmap，逐卷實測原始 BLOB、
// base64、逐卷 gzip／brotli 後的位元組數，再依高麗藏漢字數外推到全庫。
// 臨時資料庫用完即刪。

import { gzipSync, brotliCompressSync, constants as Z } from "node:zlib";
import { existsSync, unlinkSync } from "node:fs";
import { buildPosDb, openPosSource, collectPairs } from "../core/posdb";
import { openDb, buildGoryeoIndex, buildTaishoIndex, loadMapping, readJuan, normSutra } from "../core/juanindex";

const N = Number(process.argv[2] ?? 4);
const TMP = "_pos_est.db";
const b64 = (n: number) => 4 * Math.ceil(n / 3);
const MB = 1048576;
const fmt = (x: number) => (x / MB).toFixed(2).padStart(8);

// ---------------------------------------------------------------- 全庫基準

const t0 = Date.now();
const kdb = openDb("K.db");
const tdb = openDb("T.db");
const kIdx = buildGoryeoIndex(kdb, () => {});
const tIdx = buildTaishoIndex(tdb);
const pairs = collectPairs(kdb, tdb, loadMapping());

let allJuans = 0, allHanK = 0, allTextBytes = 0;
const wanted: string[] = [];
pairs.forEach((p, i) => {
  if (i % N === 0) wanted.push(p.t);
  const ki = kIdx.get(p.k)!;
  const ti = tIdx.get(normSutra(p.t).toUpperCase())!;
  for (let j = 0; j < ki.juan.length; j++) {
    const kRec = ki.juan[j];
    const tRec = ti.juan.find(x => x.juan === kRec.juan) ?? ti.juan[j];
    const kt = readJuan(kdb, kRec);
    allJuans++;
    allHanK += kt.hanzi.length;
    for (const l of kt.lines) allTextBytes += Buffer.byteLength(l.text ?? "", "utf8");
    void tRec;
  }
});
console.log(`【全庫】${pairs.length} 部經、${allJuans} 卷`);
console.log(`【全庫】高麗藏漢字 ${allHanK.toLocaleString()}`);
console.log(`【全庫】這些卷的經文（UTF-8，含標點與標記）${(allTextBytes / MB).toFixed(1)} MB`);
console.log(`【抽樣】每 ${N} 部取 1 部 → ${wanted.length} 部經（耗時 ${((Date.now() - t0) / 1000).toFixed(0)}s 讀完基準）`);

// ---------------------------------------------------------------- 抽樣建庫

if (existsSync(TMP)) unlinkSync(TMP);
buildPosDb({ outPath: TMP, tsutras: wanted, log: () => {} });
const { db, close } = openPosSource(TMP);

const rows = db.query(`
  SELECT tsutra, tjuan, ksutra, kjuan, t_han, k_han, LENGTH(data) AS blobLen, data
  FROM align ORDER BY tsutra, tjuan
`).all() as any[];

type Acc = { plain: number; b64: number; json: number; gz: number; gzB64: number; jsonGz: number; jsonBrotli: number; han: number };
const S: Acc = { plain: 0, b64: 0, json: 0, gz: 0, gzB64: 0, jsonGz: 0, jsonBrotli: 0, han: 0 };
const rawList: number[] = [], gzList: number[] = [];
const wholeBlobs: Buffer[] = [];
const perSutraPlain: number[] = [], perSutraGz: number[] = [], perSutraBr: number[] = [];

// 依經號分組，模擬「一部經一個 JSON 檔」
const bySutra = new Map<string, { tsutra: string; ksutra: string; entries: string[]; entriesGz: string[]; raw: Buffer[] }>();
for (const r of rows) {
  const blob = Buffer.from(r.data);
  const gz = gzipSync(blob);
  const entry = `"${r.tjuan}":{"tjuan":${r.tjuan},"kjuan":${r.kjuan},"blob":"${blob.toString("base64")}"}`;
  const entryGz = `"${r.tjuan}":{"tjuan":${r.tjuan},"kjuan":${r.kjuan},"blob":"${gz.toString("base64")}"}`;

  S.plain += blob.length;
  S.b64 += b64(blob.length);
  S.json += Buffer.byteLength(entry, "utf8") + 1;
  S.gz += gz.length;
  S.gzB64 += b64(gz.length);
  S.jsonGz += Buffer.byteLength(entryGz, "utf8") + 1;
  S.han += r.k_han;
  rawList.push(blob.length);
  gzList.push(gz.length);
  wholeBlobs.push(blob);

  let g = bySutra.get(r.tsutra);
  if (!g) { g = { tsutra: r.tsutra, ksutra: r.ksutra, entries: [], entriesGz: [], raw: [] }; bySutra.set(r.tsutra, g); }
  g.entries.push(entry); g.entriesGz.push(entryGz); g.raw.push(blob);
}
for (const g of bySutra.values()) {
  const doc = `{"version":1,"tsutra":"${g.tsutra}","ksutra":"${g.ksutra}","juan":{${g.entries.join(",")}}}`;
  const docGz = `{"version":1,"tsutra":"${g.tsutra}","ksutra":"${g.ksutra}","juan":{${g.entriesGz.join(",")}}}`;
  const buf = Buffer.from(doc, "utf8");
  perSutraPlain.push(buf.length);
  perSutraGz.push(gzipSync(buf).length);
  perSutraBr.push(brotliCompressSync(buf, { params: { [Z.BROTLI_PARAM_QUALITY]: 11 } }).length);
  S.jsonBrotli += buf.length;   // 佔位，稍後用 perSutraBr 取代
}
S.jsonBrotli = perSutraBr.reduce((a, b) => a + b, 0);
// per-juan JSON（把整份合併成一大檔）也量一下 gzip / brotli
const oneBigJson = Buffer.from(`{"version":1,"sutra":"all","juan":{${rows.map(r => {
  const blob = Buffer.from(r.data);
  return `"${r.tsutra}-${r.tjuan}":{"tsutra":"${r.tsutra}","tjuan":${r.tjuan},"ksutra":"${r.ksutra}","kjuan":${r.kjuan},"blob":"${blob.toString("base64")}"}`;
}).join(",")}}}`, "utf8");
const oneBigJsonGz = gzipSync(oneBigJson).length;
const oneBigJsonBr = brotliCompressSync(oneBigJson, { params: { [Z.BROTLI_PARAM_QUALITY]: 11 } }).length;
const wholeBlobBuf = Buffer.concat(wholeBlobs);
const wholeBlobGz = gzipSync(wholeBlobBuf).length;
const wholeBlobBr = brotliCompressSync(wholeBlobBuf, { params: { [Z.BROTLI_PARAM_QUALITY]: 11 } }).length;
const zs = (b: Buffer, level: number) => Buffer.from(Bun.zstdCompressSync(b, { level })).length;
const wholeBlobZs = { 3: zs(wholeBlobBuf, 3), 19: zs(wholeBlobBuf, 19) };

const n = rows.length;
const scale = allHanK / S.han;
const pctOf = (a: number[], p: number) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const sorted = rawList.slice().sort((a, b) => a - b);

console.log(`【抽樣】${n} 卷、高麗藏漢字 ${S.han.toLocaleString()}（占全庫 ${(100 * S.han / allHanK).toFixed(2)}%）`);
console.log(`       BLOB 每卷：中位數 ${sorted[sorted.length >> 1]} B、平均 ${(S.plain / n).toFixed(0)} B、p90 ${sorted[Math.floor(sorted.length * 0.9)]} B、最大 ${sorted[sorted.length - 1]} B`);
console.log(`       gzip 後每卷：平均 ${(S.gz / n).toFixed(0)} B（原始 BLOB 的 ${(100 * S.gz / S.plain).toFixed(0)}%）`);
console.log("");

const line = (name: string, sample: number, total: number, note = "") =>
  console.log(`  ${name.padEnd(34)} ${fmt(sample)} MB → 全庫 ${fmt(total)} MB   ${note}`);

console.log("【A】明文（現行 JSON 格式，BLOB 轉 base64）");
line("BLOB 原始二進位（不轉 base64）", S.plain, S.plain * scale);
line("BLOB 轉 base64", S.b64, S.b64 * scale);
line("完整 JSON（含每卷欄位名）", S.json, S.json * scale);
console.log("");
console.log("【B】每一卷各自 gzip 後再 base64（題目問的）");
line("逐卷 gzip（二進位）", S.gz, S.gz * scale, `原文的 ${(100 * S.gz / S.plain).toFixed(0)}%`);
line("逐卷 gzip 再 base64", S.gzB64, S.gzB64 * scale, `明文 JSON 的 ${(100 * S.gzB64 / S.json).toFixed(0)}%`);
line("逐卷 gzip 的完整 JSON 條目", S.jsonGz, S.jsonGz * scale);
console.log("");
console.log("【C】不分卷，整份一起壓（更好的做法）");
line("整份 JSON 明文", oneBigJson.length, oneBigJson.length * scale);
line("整份 JSON gzip", oneBigJsonGz, oneBigJsonGz * scale);
line("整份 JSON brotli(q11)", oneBigJsonBr, oneBigJsonBr * scale);
line("BLOB 串接後 gzip（純二進位檔）", wholeBlobGz, wholeBlobGz * scale);
line("BLOB 串接後 zstd(lv19)", wholeBlobZs[19], wholeBlobZs[19] * scale);
line("BLOB 串接後 brotli(q11)", wholeBlobBr, wholeBlobBr * scale);
console.log("");
console.log("【D】一部經一個 JSON 檔（網頁實際載入的單位）");
const sb = { p: perSutraPlain.reduce((a, b) => a + b, 0), g: perSutraGz.reduce((a, b) => a + b, 0), r: perSutraBr.reduce((a, b) => a + b, 0) };
line("明文", sb.p, sb.p * scale, `平均 ${(sb.p / bySutra.size / 1024).toFixed(0)} KB/檔`);
line("逐檔 gzip", sb.g, sb.g * scale, `平均 ${(sb.g / bySutra.size / 1024).toFixed(1)} KB/檔`);
line("逐檔 brotli(q11)", sb.r, sb.r * scale, `平均 ${(sb.r / bySutra.size / 1024).toFixed(1)} KB/檔`);

console.log("");
console.log("【對照】");
console.log(`  這些卷的經文（UTF-8）      ${fmt(allTextBytes)} MB`);
console.log(`  K.db 整個檔案               ${fmt(387121152)} MB（其中屬這些卷的內容約 179.5 MB）`);
const ratio = (x: number) => `${(100 * x * scale / allTextBytes).toFixed(1)}%`;
console.log(`  占經文的比例：明文 JSON ${ratio(S.json)}、逐卷 gzip+base64 ${ratio(S.gzB64)}、整份 brotli ${ratio(oneBigJsonBr)}`);
console.log(`  占 K.db 的比例：明文 JSON ${(100 * S.json * scale / 387121152).toFixed(1)}%、逐卷 gzip+base64 ${(100 * S.gzB64 * scale / 387121152).toFixed(1)}%、整份 brotli ${(100 * oneBigJsonBr * scale / 387121152).toFixed(1)}%`);

close();
kdb.close(); tdb.close();
try { unlinkSync(TMP); } catch { console.log(`（${TMP} 被鎖住，請稍後手動刪除）`); }
