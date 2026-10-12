// packdb.ts
// 用法: bun packdb.ts [tsv目錄] [輸出檔案]
//   例: bun packdb.ts k-txt K.db
//       bun packdb.ts t-txt T.db
//   省略時目錄為 txt、輸出為「目錄/前綴.db」（例：txt/T.db）
//
// 將目錄下所有 *.tsv 與 juaninfo.tsv 打包進單個 SQLite 資料庫。
// 資料庫文件名 = 第一個 tsv 文件名去掉數字部分 + ".db"（例如 T01.tsv → T.db）
//
// juaninfo.tsv 欄位：經號 冊號 經名 卷號 起點 終點 總行數 [序言行數 附文行數 序言字數 附文字數]
//   後 4 欄為選用；有提供就一併寫入 juan 表，供「只讀正文」的 API 使用。
//
// 說明:
//   1. 本版本取消序文(juan=0)設計。序文區域併入第一卷，另以序言行數欄位記錄。
//   2. 頁行碼欄號為 a-g（e/f/g 罕見但存在）。舊版本誤寫成 a-d，會丟掉這些行，
//      且會讓含 e/f/g 的卷整卷漏收（例：T2266 卷 11、12）。本版本已修正。

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// ---------- PCL 工具 ----------

interface PCL { page: number; col: string; line: number; seq: number }

const PCL_RE = /^(\d{4})([a-gA-G])(\d{2})$/;

function parsePCL(pcl: string): PCL | null {
  const m = PCL_RE.exec(pcl);
  if (!m) return null;
  const page = Number(m[1]);
  const col = m[2].toLowerCase();
  const line = Number(m[3]);
  const colIdx = col.charCodeAt(0) - 97; // a=0 … g=6
  // seq：可排序整數鍵。 page*1000 + colIdx*100 + line
  return { page, col, line, seq: page * 1000 + colIdx * 100 + line };
}

// ---------- 主流程 ----------

const dir = process.argv[2] ?? "txt";
const outArg = process.argv[3];

if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`目錄不存在: ${dir}`);
  process.exit(1);
}

const files = readdirSync(dir).filter(f => /^[A-Z]\d+.*\.tsv$/i.test(f)).sort();
if (files.length === 0) {
  console.error(`${dir} 下沒有 *.tsv 文件`);
  process.exit(1);
}

const firstFile = files[0];
const dbBase = firstFile.replace(/\.tsv$/i, "").replace(/\d+/g, "");
const dbPath = outArg ?? join(dir, `${dbBase}.db`);

console.log(`打包 ${files.length} 個文件 -> ${dbPath}`);

const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = OFF");
db.exec("PRAGMA synchronous = OFF");

db.exec(`
  DROP TABLE IF EXISTS lines;
  DROP TABLE IF EXISTS juan;
  CREATE TABLE lines (
    vol   INTEGER NOT NULL,
    pcl   TEXT    NOT NULL,
    seq   INTEGER NOT NULL,
    page  INTEGER NOT NULL,
    col   TEXT    NOT NULL,
    line  INTEGER NOT NULL,
    text  TEXT    NOT NULL,
    PRIMARY KEY (vol, pcl)
  );
  CREATE INDEX idx_lines_seq ON lines(vol, seq);

  CREATE TABLE juan (
    sutra          TEXT    NOT NULL,
    vol            INTEGER NOT NULL,
    name           TEXT,
    juan           INTEGER NOT NULL,
    start_pcl      TEXT    NOT NULL,
    end_pcl        TEXT    NOT NULL,
    start_seq      INTEGER NOT NULL,
    end_seq        INTEGER NOT NULL,
    total_lines    INTEGER,
    preface_lines  INTEGER,   -- 卷首屬於序言的行數（正文從其後開始）
    appendix_lines INTEGER,   -- 卷末屬於附文的行數（正文到其前結束）
    preface_chars  INTEGER,   -- 序言漢字數
    appendix_chars INTEGER,   -- 附文漢字數
    PRIMARY KEY (sutra, juan)
  );
  CREATE INDEX idx_juan_start ON juan(vol, start_seq);
  CREATE INDEX idx_juan_range ON juan(vol, start_seq, end_seq);
`);

// ---- 1) 導入所有 lines ----

const insLine = db.prepare(
  "INSERT INTO lines (vol, pcl, seq, page, col, line, text) VALUES (?, ?, ?, ?, ?, ?, ?)"
);

let skippedLines = 0;
const packLines = db.transaction(() => {
  for (const file of files) {
    const vm = /^[A-Z](\d+)/i.exec(file);
    if (!vm) continue;
    const vol = Number(vm[1]);
    const content = readFileSync(join(dir, file), "utf-8");
    let count = 0, skipped = 0;
    for (const raw of content.split(/\r?\n/)) {
      if (!raw) continue;
      const tab = raw.indexOf("\t");
      const pcl = tab === -1 ? raw : raw.slice(0, tab);
      const text = tab === -1 ? "" : raw.slice(tab + 1);
      const p = parsePCL(pcl);
      if (!p) { skipped++; skippedLines++; continue; }
      try {
        insLine.run(vol, pcl.toLowerCase(), p.seq, p.page, p.col, p.line, text);
      } catch (e) {
        console.log(`  重複的頁行碼 ${vol} ${pcl}`);
        console.log(e);
        process.exit(1);
      }
      count++;
    }
    console.log(`  ${file}: vol=${vol}, ${count} 行${skipped ? `（略過格式異常 ${skipped} 行）` : ""}`);
  }
});
packLines();

// ---- 2) 導入 juaninfo.tsv ----
//
// 各卷的 start_pcl 直接採用 juaninfo.tsv 的記錄；序文區域落在第一卷範圍內，
// 另以 preface_lines / appendix_lines 記錄要跳過的行數。

const jiPath = join(dir, "juaninfo.tsv");
if (!statSync(jiPath, { throwIfNoEntry: false })?.isFile()) {
  console.error(`找不到 ${jiPath}`);
  db.close();
  process.exit(1);
}
const jiContent = readFileSync(jiPath, "utf-8");

interface JuanRow {
  sutra: string; vol: number; name: string; juan: number;
  start: string; end: string; total: number;
  preLines: number | null; postLines: number | null;
  preChars: number | null; postChars: number | null;
}

const juanRows: JuanRow[] = [];
const num = (s: string | undefined): number | null => (s === undefined || s === "" ? null : Number(s));
{
  const lines = jiContent.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    const parts = raw.split("\t");
    if (i === 0 && parts[0] === "經號") continue;      // 表頭
    if (parts.length < 7) continue;
    const [sutra, volStr, name, juanStr, start, end, totalStr] = parts;
    if (!/^\d/.test(sutra)) continue;
    juanRows.push({
      sutra,
      vol: Number(volStr),
      name: name ?? "",
      juan: Number(juanStr),
      start,
      end,
      total: Number(totalStr ?? 0),
      preLines: num(parts[7]), postLines: num(parts[8]),
      preChars: num(parts[9]), postChars: num(parts[10]),
    });
  }
}
console.log(`  juaninfo.tsv: ${juanRows.length} 條記錄`);

const insJuan = db.prepare(`
  INSERT OR REPLACE INTO juan
  (sutra, vol, name, juan, start_pcl, end_pcl, start_seq, end_seq, total_lines,
   preface_lines, appendix_lines, preface_chars, appendix_chars)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

let skippedJuan = 0;
const packJuan = db.transaction(() => {
  for (const r of juanRows) {
    const s = parsePCL(r.start);
    const e = parsePCL(r.end);
    if (!s || !e) { skippedJuan++; continue; }
    insJuan.run(r.sutra, r.vol, r.name, r.juan, r.start.toLowerCase(), r.end.toLowerCase(),
      s.seq, e.seq, r.total, r.preLines, r.postLines, r.preChars, r.postChars);
  }
});
packJuan();
if (skippedJuan) console.log(`  略過頁行碼異常的卷記錄: ${skippedJuan}`);

// ---- 3) 檢查 ----

const nLines = (db.query("SELECT COUNT(*) n FROM lines").get() as any).n;
const nJuan = (db.query("SELECT COUNT(*) n FROM juan").get() as any).n;
const missing = (db.query(`
  SELECT COUNT(*) n FROM juan j WHERE NOT EXISTS (
    SELECT 1 FROM lines l WHERE l.vol = j.vol AND l.seq >= j.start_seq AND l.seq <= j.end_seq)
`).get() as any).n;
console.log(`  檢查: lines ${nLines} 行, juan ${nJuan} 卷, 卷範圍無資料 ${missing} 卷${skippedLines ? `, 略過行 ${skippedLines}` : ""}`);

db.exec("VACUUM");
db.close();
console.log("完成。");
