// buildpos.ts — 建置位置對照資料庫 posmap.db（並可匯出網頁用的 JSON）
//
// 用法：
//   bun buildpos.ts --sutra 0001              # 只建大正 0001 經（高麗 0647），即任務的試驗對象
//   bun buildpos.ts --sutra 0001,0002 --json posdata
//   bun buildpos.ts --all                     # 全庫（任務第 9 點，等指示再跑）
//
// 參數：
//   --kdb <path>   高麗藏資料庫（預設 K.db）
//   --tdb <path>   大正藏資料庫（預設 T.db）
//   --out <path>   輸出資料庫（預設 posmap.db）
//   --sutra <list> 只建這些大正經號，逗號分隔（可重複）
//   --all          建全部可對照的經
//   --json <dir>   另外把各經匯出成網頁用的 JSON（<dir>/<大正經號>.json）
//   --pos <file>   另外匯出單一 binary asset（Go 端 gopos 直接吃這個檔）
//   --pos-codec     asset 的壓縮方式：none / gzip / zstd（預設 zstd）
//   --keep         不要清掉既有的輸出資料庫（增量補建）

import { mkdirSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { buildPosDb, openPosSource, listTsutras, listJuans } from "../core/posdb";
import { recToJsonEntry, SutraJson, decodeAlign } from "../core/posmap";
import { bytesToB64 } from "../core/posfmt";
import { normSutra } from "../core/juanindex";
import { writePosAsset, CodecName } from "../core/posasset";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);

const sutras: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--sutra") sutras.push(...String(argv[i + 1] ?? "").split(",").map(s => s.trim()).filter(Boolean));
}
const ALL = has("--all");
const FROM = flag("--from");
if (!ALL && sutras.length === 0 && !FROM) {
  console.log(`用法：
  bun buildpos.ts --sutra 0001 [--json posdata]   只建指定大正經號
  bun buildpos.ts --all                           全庫
  bun buildpos.ts --from posmap.db --json posdata 不重建，直接從既有資料庫匯出
選項：--kdb K.db --tdb T.db --out posmap.db --pos <asset> --pos-codec zstd --keep`);
  process.exit(1);
}

const t0 = Date.now();
const outPath = FROM ?? flag("--out") ?? "posmap.db";
if (FROM) {
  console.log(`[跳過建庫] 直接用既有的 ${FROM}`);
} else {
  const stat = buildPosDb({
    kdbPath: flag("--kdb") ?? "K.db",
    tdbPath: flag("--tdb") ?? "T.db",
    outPath,
    tsutras: ALL ? undefined : sutras,
    fresh: !has("--keep"),
    log: m => console.log(m),
  });
  console.log(`[完成] ${stat.juans} 卷，耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s，` +
    `${outPath} ${(statSync(outPath).size / 1048576).toFixed(2)} MB`);
}

// ---- 匯出單一 binary asset ----
const posPath = flag("--pos");
if (posPath) {
  const codec = (flag("--pos-codec") ?? "zstd") as CodecName;
  const { db, close } = openPosSource(outPath);
  const st = writePosAsset(db, posPath, codec);
  close();
  console.log(`[asset] ${posPath}：${st.sutras} 部經 / ${st.juans} 卷，` +
    `payload ${(st.rawLen / 1048576).toFixed(2)} MB → ${codec} ${(st.compLen / 1048576).toFixed(2)} MB，` +
    `檔案 ${(statSync(posPath).size / 1048576).toFixed(2)} MB`);
}

// ---- 匯出網頁用的 JSON ----
const jsonDir = flag("--json");
if (jsonDir) {
  mkdirSync(jsonDir, { recursive: true });
  const { db, close } = openPosSource(outPath);
  const only = new Set(sutras.map(s => normSutra(s).toUpperCase()));
  for (const ts of listTsutras(db)) {
    if (only.size > 0 && !only.has(ts)) continue;
    const rows = listJuans(db, ts);
    const ksutra = rows[0]?.ksutra ?? "";
    const juan: SutraJson["juan"] = {};
    const q = db.query("SELECT data FROM align WHERE tsutra = ? AND tjuan = ?");
    for (const r of rows) {
      const blob = (q.get(ts, r.tjuan) as { data: Uint8Array }).data;
      decodeAlign(new Uint8Array(blob));   // 驗證可解碼
      juan[String(r.tjuan)] = { tjuan: r.tjuan, kjuan: r.kjuan, blob: bytesToB64(new Uint8Array(blob)) };
    }
    const json: SutraJson = { version: 1, tsutra: ts, ksutra, juan };
    const p = join(jsonDir, `${ts}.json`);
    writeFileSync(p, JSON.stringify(json));
    console.log(`[匯出] ${p}（${rows.length} 卷，${(statSync(p).size / 1024).toFixed(1)} KB）`);
  }
  close();
}

// ---- 摘要 ----
const { db, source, close } = openPosSource(outPath);
const ts = listTsutras(db);
console.log(`[摘要] 收錄 ${ts.length} 部大正經：${ts.slice(0, 20).join(" ")}${ts.length > 20 ? " …" : ""}`);
for (const t of ts.slice(0, 3)) {
  for (const r of listJuans(db, t).slice(0, 3)) {
    console.log(`  T${r.tsutra}/${r.tjuan} ⇄ K${r.ksutra}/${r.kjuan}  ` +
      `T ${r.t_han} 字（正文 ${r.t_body0}–${r.t_body1}）  K ${r.k_han} 字（正文 ${r.k_body0}–${r.k_body1}）  ` +
      `相似度 ${r.similarity.toFixed(4)}  對應段 BLOB`);
  }
}
const rec = source.align(sutras[0] ?? ts[0], 1);
if (rec) console.log(`  [檢查] ${sutras[0] ?? ts[0]} 卷1 對應段數 ${rec.runs.length / 3}，T 正文 ${rec.tBody[0]}–${rec.tBody[1]}，K 正文 ${rec.kBody[0]}–${rec.kBody[1]}`);
close();
