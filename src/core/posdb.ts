// posdb.ts — 位置對照資料庫（posmap.db）的建置與讀取
//
// 建置：讀 K.db / T.db，逐卷 diff，把「1:1 對應段」與「每行幾何」壓成 BLOB 存進 posmap.db。
// 之後查詢只要 posmap.db，不再需要 K.db / T.db（任務第 8 點的「不再依賴」）。
//
// 本檔依賴 bun:sqlite，只在 Bun 端執行；瀏覽器端請用 posmap.ts 的 jsonSource。

import { Database } from "bun:sqlite";
import { existsSync, unlinkSync } from "fs";
import {
  openDb, buildGoryeoIndex, buildTaishoIndex, loadMapping, readJuan, normSutra, hanOnly,
} from "./juanindex";
import { myersDiff, bodyBoundsOf, buildAlignment, compareHanzi } from "./similarity";
import { AlignBody, AlignRec, AlignSource, SideGeom, encodeAlign, decodeAlign, mergeRunTriples, POSDB_VERSION } from "./posmap";
import { parsePcl, seqOf, seqOfPcl } from "./posfmt";

export interface Pair { k: string; t: string; n: number; kjuan: number; tjuan: number }

/** 挑出可逐卷對照的 (高麗經, 大正經) 配對：一對一且卷數相同（與 comparejuan.ts 相同規則） */
export function collectPairs(
  kdb: Database, tdb: Database, mapping: Map<string, any>,
): Pair[] {
  const kIdx = buildGoryeoIndex(kdb, () => {});
  const tIdx = buildTaishoIndex(tdb);
  const out: Pair[] = [];
  for (const [k, ki] of [...kIdx].sort((a, b) => a[0].localeCompare(b[0]))) {
    const m = mapping.get(k);
    if (!m || m.kind !== "exact") continue;
    const ti = tIdx.get(normSutra(m.target!).toUpperCase());
    if (!ti || ti.juanCount !== ki.juanCount) continue;
    out.push({ k, t: normSutra(m.target!), n: ki.juanCount, kjuan: 0, tjuan: 0 });
  }
  return out;
}

function geomOf(db: Database, rec: any): { g: SideGeom; hanzi: string } {
  const jt = readJuan(db, rec);
  const n = jt.lines.length;
  const lineSeq = new Int32Array(n);
  const lineStart = new Int32Array(n + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    lineSeq[i] = seqOf(parsePcl(jt.lines[i].pcl)!);
    lineStart[i] = acc;
    acc += hanOnly(jt.lines[i].text ?? "").length;
  }
  lineStart[n] = acc;
  return { g: { vol: rec.vol, lineSeq, lineStart, nLines: n, han: acc }, hanzi: jt.hanzi };
}

/**
 * 卷首／卷末那一段是否真的是「單邊」的序言／附文（只在其中一藏出現）。
 * 規則與 juanmarks.ts 完全一致（也是 juan-prolog.tsv / juan-epilog.tsv 的「類型」欄）：
 * 長度達 REAL_MARK 字，且該區段內兩藏幾乎不重疊（相同字數 < 該區最大長度的一半）。
 *
 * 只有這種才需要「跳過」；反之（如兩藏都有的卷末卷題，只是異體字之差）仍然要能對照。
 */
export const REAL_MARK = 100;

export function isRealMark(lenA: number, lenB: number, matchedRegion: number): boolean {
  const mx = Math.max(lenA, lenB);
  return mx >= REAL_MARK && matchedRegion < 0.5 * mx;
}

export interface BuildOptions {
  kdbPath?: string;
  tdbPath?: string;
  outPath?: string;
  mappingPath?: string;
  /** 只建這幾個大正經號（未給則全部） */
  tsutras?: string[];
  fresh?: boolean;
  log?: (msg: string) => void;
}

export interface BuildStat { juans: number; pairs: number; skipped: number }

export function buildPosDb(opts: BuildOptions = {}): BuildStat {
  const kdbPath = opts.kdbPath ?? "K.db";
  const tdbPath = opts.tdbPath ?? "T.db";
  const outPath = opts.outPath ?? "posmap.db";
  const log = opts.log ?? (() => {});
  const want = opts.tsutras ? new Set(opts.tsutras.map(s => normSutra(s).toUpperCase())) : null;

  if (opts.fresh !== false && existsSync(outPath)) { unlinkSync(outPath); log(`[建庫] 刪除舊的 ${outPath}`); }
  const out = new Database(outPath);
  out.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    CREATE TABLE IF NOT EXISTS align (
      tsutra TEXT NOT NULL, tjuan INTEGER NOT NULL,
      ksutra TEXT NOT NULL, kjuan INTEGER NOT NULL,
      t_vol INTEGER NOT NULL, k_vol INTEGER NOT NULL,
      t_start_seq INTEGER NOT NULL, t_end_seq INTEGER NOT NULL,
      k_start_seq INTEGER NOT NULL, k_end_seq INTEGER NOT NULL,
      t_han INTEGER NOT NULL, k_han INTEGER NOT NULL,
      t_body0 INTEGER NOT NULL, t_body1 INTEGER NOT NULL,
      k_body0 INTEGER NOT NULL, k_body1 INTEGER NOT NULL,
      similarity REAL NOT NULL, strict_similarity REAL NOT NULL,
      coarse INTEGER NOT NULL, version INTEGER NOT NULL,
      t_start_pcl TEXT NOT NULL, k_start_pcl TEXT NOT NULL,
      data BLOB NOT NULL,
      PRIMARY KEY (tsutra, tjuan)
    );
    CREATE INDEX IF NOT EXISTS align_k ON align (ksutra, kjuan);
    CREATE INDEX IF NOT EXISTS align_tvol ON align (t_vol, t_start_seq, t_end_seq);
    CREATE INDEX IF NOT EXISTS align_kvol ON align (k_vol, k_start_seq, k_end_seq);
  `);

  const kdb = openDb(kdbPath);
  const tdb = openDb(tdbPath);
  const kIdx = buildGoryeoIndex(kdb, m => log(`[索引] ${m}`));
  const tIdx = buildTaishoIndex(tdb);
  const mapping = loadMapping(opts.mappingPath ?? "goryeo2taisho.json");

  const pairs = collectPairs(kdb, tdb, mapping).filter(p => !want || want.has(p.t.toUpperCase()));
  let juans = 0, skipped = 0;
  const ins = out.prepare(`
    INSERT OR REPLACE INTO align
      (tsutra, tjuan, ksutra, kjuan, t_vol, k_vol,
       t_start_seq, t_end_seq, k_start_seq, k_end_seq,
       t_han, k_han,
       t_body0, t_body1, k_body0, k_body1, similarity, strict_similarity, coarse, version,
       t_start_pcl, k_start_pcl, data)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  out.exec("BEGIN");
  for (const p of pairs) {
    const ki = kIdx.get(p.k)!;
    const ti = tIdx.get(p.t.toUpperCase())!;
    for (let i = 0; i < ki.juan.length; i++) {
      const kRec = ki.juan[i];
      const tRec = ti.juan.find(j => j.juan === kRec.juan) ?? ti.juan[i];
      p.kjuan = kRec.juan; p.tjuan = tRec.juan;
      const kt = geomOf(kdb, kRec);
      const tt = geomOf(tdb, tRec);

      const segs = myersDiff(kt.hanzi, tt.hanzi);
      const bb = bodyBoundsOf(segs, kt.hanzi.length, tt.hanzi.length);
      const d = compareHanzi(kt.hanzi, tt.hanzi, segs);

      // 只有「兩藏真的不重疊」的卷首／卷末才需要跳過；其餘（兩藏都有、只是異體字之差，
      // 例如卷末卷題）仍留在可對照範圍內，否則那些字會被錯誤地拉回正文邊界。
      const realPre = isRealMark(d.preA, d.preB, d.matchedPre);
      const realPost = isRealMark(d.postA, d.postB, d.matchedPost);
      const tBody0 = realPre ? bb.headB : 0;
      const tBody1 = Math.max(tBody0, realPost ? bb.tailB : tt.g.han);
      const kBody0 = realPre ? bb.headA : 0;
      const kBody1 = Math.max(kBody0, realPost ? bb.tailA : kt.g.han);
      // 對應段不裁切，整卷的對齊都留著；要不要跳過由上面的正文範圍決定。
      // 再合併首尾相接的段（純替代不改位移差，會被併掉），體積可降一個量級。
      const runs = mergeRunTriples(Int32Array.from(buildAlignment(segs).flatMap(r => [r.t, r.k, r.len])));

      const body: AlignBody = {
        t: tt.g, k: kt.g,
        tBody: Int32Array.from([tBody0, tBody1]),
        kBody: Int32Array.from([kBody0, kBody1]),
        tPre: bb.headB, tPost: tt.g.han - bb.tailB,
        kPre: bb.headA, kPost: kt.g.han - bb.tailA,
        runs,
        coarse: d.coarse,
      };
      ins.run(
        p.t.toUpperCase(), tRec.juan, p.k.toUpperCase(), kRec.juan,
        tt.g.vol, kt.g.vol,
        seqOfPcl(tRec.start_pcl)!, seqOfPcl(tRec.end_pcl)!,
        seqOfPcl(kRec.start_pcl)!, seqOfPcl(kRec.end_pcl)!,
        tt.g.han, kt.g.han,
        tBody0, tBody1, kBody0, kBody1,
        d.similarity, d.strictSimilarity, d.coarse ? 1 : 0, POSDB_VERSION,
        tRec.start_pcl, kRec.start_pcl,
        encodeAlign(body),
      );
      juans++;
      if (juans % 200 === 0) log(`[建庫] ${juans} 卷…`);
    }
  }
  out.exec("COMMIT");
  out.exec("ANALYZE");
  out.close();
  kdb.close();
  tdb.close();
  log(`[建庫] 完成：${pairs.length} 部經、${juans} 卷 → ${outPath}`);
  return { juans, pairs: pairs.length, skipped };
}

// ---------------------------------------------------------------- 讀取

const ROW_COLS = `tsutra, tjuan, ksutra, kjuan, t_vol, k_vol,
  t_start_seq, t_end_seq, k_start_seq, k_end_seq, t_han, k_han,
  t_body0, t_body1, k_body0, k_body1, similarity, strict_similarity, coarse, t_start_pcl, k_start_pcl, data`;

export interface PosDb {
  db: Database;
  source: AlignSource;
  /** 由「大正藏冊號 + 該冊內的頁欄行流水號」找出經號與卷號（不需 T.db） */
  findByTsutra(vol: number, seq: number): { tsutra: string; tjuan: number } | null;
  /** 由「高麗藏冊號 + 流水號」找出經號與卷號（不需 K.db） */
  findByKsutra(vol: number, seq: number): { ksutra: string; kjuan: number } | null;
  close(): void;
}

/** 開啟 posmap.db，回傳一個 AlignSource（每次查詢即時解碼該卷） */
export function openPosSource(path = "posmap.db"): PosDb {
  const db = new Database(path, { readonly: true });
  const q = db.query(`SELECT ${ROW_COLS} FROM align WHERE tsutra = ? AND tjuan = ?`);
  const qt = db.query(`
    SELECT tsutra, tjuan FROM align
    WHERE t_vol = ? AND t_start_seq <= ? AND t_end_seq >= ?
    ORDER BY t_start_seq LIMIT 1
  `);
  const qk = db.query(`
    SELECT ksutra, kjuan FROM align
    WHERE k_vol = ? AND k_start_seq <= ? AND k_end_seq >= ?
    ORDER BY k_start_seq LIMIT 1
  `);
  const build = (row: any): AlignRec | null => {
    if (!row) return null;
    return {
      tsutra: row.tsutra, tjuan: row.tjuan, ksutra: row.ksutra, kjuan: row.kjuan,
      ...decodeAlign(new Uint8Array(row.data)),
    };
  };
  return {
    db,
    source: { align: (s, j) => build(q.get(normSutra(s).toUpperCase(), j)) },
    findByTsutra: (vol, seq) => (qt.get(vol, seq, seq) as any) ?? null,
    findByKsutra: (vol, seq) => (qk.get(vol, seq, seq) as any) ?? null,
    close: () => db.close(),
  };
}

/** 列出 posmap.db 中收錄的大正經號 */
export function listTsutras(db: Database): string[] {
  return (db.query("SELECT DISTINCT tsutra FROM align ORDER BY tsutra").all() as { tsutra: string }[]).map(r => r.tsutra);
}

/** 取某一大正經的全部卷（含 pcl 等中繼資料，供檢視） */
export function listJuans(db: Database, tsutra: string): any[] {
  return db.query(`
    SELECT tsutra, tjuan, ksutra, kjuan, t_vol, k_vol, t_han, k_han,
           t_start_seq, t_end_seq, k_start_seq, k_end_seq,
           t_body0, t_body1, k_body0, k_body1, similarity, strict_similarity, coarse,
           t_start_pcl, k_start_pcl
    FROM align WHERE tsutra = ? ORDER BY tjuan
  `).all(normSutra(tsutra).toUpperCase());
}
