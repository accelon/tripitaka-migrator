
# 快速讀取經卷

## 源文件結構

參考 \`fileformat.md\`。

簡言之：

- \`T01.tsv\`、\`T02.tsv\` …：每冊一個文件，行首為 4 位頁號 + 1 位欄號(a-d) + 2 位行號，製表符後為經文。此結構簡稱 **pcl**（\`page\` \`column\` \`line\`）。
- \`juaninfo.tsv\`：記錄每卷的 \`sutra\`、\`vol\`、\`name\`、\`juan\`、\`start_pcl\`、\`end_pcl\`、\`total_lines\`。

---

## SQLite Schema

打包後的數據庫文件名為 **\`T.db\`**（由第一個 tsv 文件名去掉數字部分得到）。Schema 面向 API 讀取優化：

\`\`\`sql
CREATE TABLE lines (
  vol   INTEGER NOT NULL,   -- 冊號
  pcl   TEXT    NOT NULL,   -- 原始頁行碼，如 "0001a02"
  seq   INTEGER NOT NULL,   -- 可排序整數鍵：page*1000 + colIdx*100 + line
  page  INTEGER NOT NULL,
  col   TEXT    NOT NULL,
  line  INTEGER NOT NULL,
  text  TEXT    NOT NULL,
  PRIMARY KEY (vol, pcl)
);
CREATE INDEX idx_lines_seq ON lines(vol, seq);

CREATE TABLE juan (
  sutra       TEXT    NOT NULL,   -- 4 位數字 + 可選字母後綴
  vol         INTEGER NOT NULL,
  name        TEXT,
  juan        INTEGER NOT NULL,   -- 卷號，從 1 開始
  start_pcl   TEXT    NOT NULL,
  end_pcl     TEXT    NOT NULL,
  start_seq   INTEGER NOT NULL,
  end_seq     INTEGER NOT NULL,
  total_lines INTEGER,
  preface_lines  INTEGER,         -- 卷首屬於序言的行數（正文從其後開始）
  appendix_lines INTEGER,         -- 卷末屬於附文的行數（正文到其前結束）
  preface_chars  INTEGER,         -- 序言漢字數
  appendix_chars INTEGER,         -- 附文漢字數
  PRIMARY KEY (sutra, juan)
);
CREATE INDEX idx_juan_start ON juan(vol, start_seq);
CREATE INDEX idx_juan_range ON juan(vol, start_seq, end_seq);
\`\`\`

### 設計說明

1. **\`seq\` 是核心排序鍵**。\`pcl\` 本身是人類可讀的字符串，但比較不便；\`seq = page*1000 + colIdx*100 + line\` 在每冊內單調遞增，讓「卷內範圍」「冊內範圍」變成普通的 B-tree 範圍掃描。欄號 a–g（a=0 … g=6），\`packdb.ts\` 必須接受 a–g，否則 e/f/g 的行會整批漏收。
2. **\`juan\` 表只記錄 \`juan >= 1\`**。序文不單獨存在 —— \`juaninfo.tsv\` 中卷一的 \`start_pcl\` 已經覆蓋序文區（如 T01 卷一從 \`0001a01\` 起，包含 \`0001a02 No.1\`），序文自然歸屬於卷一。
3. **序言／附文改以行數記錄**。\`preface_lines\` / \`appendix_lines\` 由 \`juaninfo.tsv\` 帶入，兩者皆 0 表示整卷都是正文。要取正文即跳過前 \`preface_lines\` 行、去掉後 \`appendix_lines\` 行（見 \`getJuanBody\`）。
4. **經號統一 4 位數字 + 可選字母後綴**，比較時一律 \`LOWER(sutra)\`，兼容數據中 \`0128a\` 與 \`0150A\` 這類大小寫混用。
5. **\`juan.vol\` 必須與 \`lines.vol\` 一致**。舊版 K.db 兩者錯位（見 \`k-errata.md\`），已由 \`makejuaninfo.ts\` + \`packdb.ts\` 修正；重新打包後每卷範圍在其冊中都有資料。

---

## API

實作位於 **\`sqlaccess.ts\`**。所有 API 只返回數據，**不打印任何東西**。

### 模塊入口

\`\`\`ts
import { openDb, closeDb } from "./sqlaccess";

openDb();          // 自動尋找 txt/T.db 或 ./T.db；也可 openDb("K.db")
// ... 調用其它 API ...
closeDb();
\`\`\`

未顯式調用 \`openDb()\` 時，第一次調用任何 API 會自動打開默認數據庫。\`closeDb()\` 可選，主要給長駐進程或測試使用。

### 類型

\`\`\`ts
interface JuanRange {
  sutra: string;
  vol: number;
  juan: number;
  start_pcl: string;
  end_pcl: string;
  total_lines: number | null;
}

interface SutraJuan {
  sutra: string;
  juan: number;
}
\`\`\`

### 核心 API（對應 \`sqlaccess.md\`）

#### \`PclByJuan(sutra, juan = 1): JuanRange | null\`

取出某卷經文的冊號、起止頁行碼。找不到返回 \`null\`。

\`\`\`ts
PclByJuan("1", 1);
// → { sutra: "0001", vol: 1, juan: 1,
//     start_pcl: "0001a01", end_pcl: "0011a01", total_lines: 867 }

PclByJuan("128a");        // juan 缺省為 1
// → { sutra: "0128a", vol: 2, juan: 1, ... }
\`\`\`

\`sutra\` 可省略前導零（\`"1" = "0001"\`），大小寫不敏感。

#### \`pclRange(vol, start_pcl, end_pcl?): string[]\`

給定起始頁行碼，返回頁行碼數組（升序）。不指定 \`end_pcl\` 時讀取到該頁末尾（\`page + "d99"\`）。

\`\`\`ts
pclRange(1, "0001a05");
// → ["0001a05", "0001a06", ..., "0001d99"]

pclRange(1, "0001a05", "0001b03");
// → ["0001a05", "0001a06", ..., "0001b03"]
\`\`\`

若 \`start_pcl\` / \`end_pcl\` 格式錯誤，返回 \`[]\`。

#### \`SutraJuanByPcl(vol, pcl): SutraJuan | null\`

給定冊號與頁行碼，返回該位置所屬的經號、卷號。

\`\`\`ts
SutraJuanByPcl(1, "0001a02");
// → { sutra: "0001", juan: 1 }

SutraJuanByPcl(1, "0016b12");
// → { sutra: "0001", juan: 3 }
\`\`\`

\`pcl\` 落在 \`juaninfo.tsv\` 未覆蓋的區段（缺號、補白等）時返回 \`null\`。

#### \`getJuan(sutra, juan = 1): string[]\`

取出某卷經文（純文本，每元素一行）。

\`\`\`ts
getJuan("1", 1).slice(0, 3);
// → ["", "No.1", "長阿含經序"]
\`\`\`

找不到返回 \`[]\`。

#### \`getJuanWithPCL(sutra, juan = 1): string[]\`

同上，但每行形如 \`pcl\\ttext\`，即原始文件的切片。

\`\`\`ts
getJuanWithPCL("1", 1).slice(0, 3);
// → ["0001a01\\t", "0001a02\\tNo.1", "0001a03\\t長阿含經序"]
\`\`\`

#### \`juanCount(sutra): number\`

某經有多少卷（\`juan >= 1\`，序文不單獨計）。

\`\`\`ts
juanCount("1");      // → 22
juanCount("128a");   // → 1
\`\`\`

#### \`getJuanBody(sutra, juan = 1): string[]\`

**只取正文**：跳過卷首的序言、去掉卷末的附文（依 \`juan\` 表的 \`preface_lines\` / \`appendix_lines\`）。
兩者皆 0 時等同 \`getJuan\`。

\`\`\`ts
getJuan("1", 1).length;      // → 586
getJuanBody("1", 1).length;  // → 484（去掉了 102 行的《大唐三藏聖教序》）
getJuanBody("1", 1)[0];
// → "大般若經初會序^half〔西明寺沙門玄則製〕^p"
\`\`\`

#### \`getJuanBodyWithPCL(sutra, juan = 1): string[]\`

同上，但每行形如 \`pcl\\ttext\`。

#### \`getJuanPreface(sutra, juan = 1): string[]\` / \`getJuanAppendix(sutra, juan = 1): string[]\`

單獨取出該卷的序言／附文（純文本）。沒有時返回 \`[]\`。

### 輔助 API

供 CLI 或上層使用，同樣不打印。

| 函數 | 返回 | 用途 |
|---|---|---|
| \`hasVol(vol)\` | \`boolean\` | 該冊是否有數據 |
| \`hasPcl(vol, pcl)\` | \`boolean\` | 該冊中該頁行碼是否存在 |
| \`firstPcl(vol)\` | \`string \\| null\` | 該冊第一行的 pcl |
| \`linesFromPcl(vol, pcl, n)\` | \`string[]\` | 從指定 pcl 起取 n 行（帶 pcl） |
| \`headOfVol(vol, n)\` | \`string[]\` | 該冊最開頭 n 行（帶 pcl） |
| \`normalizePCL(s)\` | \`string \\| null\` | 規範化 pcl，如 \`"1a2"\` → \`"0001a02"\` |
| \`normalizeSutra(s)\` | \`string\` | 規範化經號，如 \`"1"\` → \`"0001"\`、\`"128a"\` → \`"0128a"\` |

### 輸入規範化

- **經號**：數字部分補齊 4 位，字母後綴保留。\`"1" = "0001"\`，\`"128A" = "0128A"\`。比較時統一 \`LOWER()\`。
- **pcl**：\`^(\\d{1,4})([a-g])(\\d{1,2})$\`（大小寫均可），補齊為 \`NNNNaNN\`。\`"1a2"\`、\`"0001A02"\`、\`"0001a02"\` 三者等價。欄號可到 g；未指定終點時，讀到本頁最後一欄（\`g99\`）。

---

## CLI 應用程序

### \`packdb.ts\` — 打包

\`\`\`bat
bun packdb.ts [tsv目錄] [輸出檔案]     :: 例: bun packdb.ts k-txt K.db
\`\`\`

讀取目錄下所有 \`T*.tsv\` 與 \`juaninfo.tsv\`，打包為 \`T.db\`（文件名取自第一個 tsv 去掉數字部分；給了輸出檔案則以此為準）。序文併入卷一，另以 \`preface_lines\` 等欄位記錄。

### \`getdb.ts\` — 查詢

\`\`\`bat
bun getdb.ts                          :: 顯示用法
bun getdb.ts T1 [pcl]                 :: 冊模式
bun getdb.ts <經號> [卷號]             :: 經模式
\`\`\`

**冊模式**（第一參數形如 \`T01\` / \`T1\`）：

- 第二參數為 pcl，顯示該處所屬的冊號、經號、卷號、總卷數，並打印從該 pcl 起 5 行。
- 省略第二參數時打印該冊最開頭 5 行。

**經模式**（第一參數為數字或數字+字母後綴）：

- 第二參數為卷號，缺省 1。
- 顯示冊號、經號、卷號、總卷數，並打印該卷起 5 行。
- 經號可省略前導零：\`1 = 0001\`，\`128a = 0128a\`，\`150B = 0150B\`。

**輸出格式**（兩種模式一致）：

\`\`\`
Vol=<冊號>  Sutra=<經號>  Juan=<卷號>  Total=<該經總卷數>
< pcl >\\t< text >
< pcl >\\t< text >
...
\`\`\`

示例：

\`\`\`bat
> bun getdb.ts 1
Vol=1  Sutra=0001  Juan=1  Total=22
0001a01
0001a02  No.1
0001a03  長阿含經序
0001a04  長安釋僧肇述
0001a05  夫宗極絶於稱謂。賢聖以之沖默。玄旨非言

> bun getdb.ts T1 0001a02
Vol=1  Sutra=0001  Juan=1  Total=22
0001a02  No.1
0001a03  長阿含經序
0001a04  長安釋僧肇述
0001a05  夫宗極絶於稱謂。賢聖以之沖默。玄旨非言
0001a06  不傳。釋迦所以致教。是以如來出世。大教

> bun getdb.ts 128a
Vol=2  Sutra=0128a  Juan=1  Total=1
0835c13  ...
\`\`\`

---

## 文件佈局

\`\`\`
.
├── txt/
│   ├── T01.tsv
│   ├── T02.tsv
│   ├── juaninfo.tsv
│   └── T.db          ← packdb.ts 產出
├── packdb.ts
├── api.ts            ← 數據層，不打印
└── getdb.ts          ← CLI，僅負責解析參數與打印
\`\`\`

**分層原則**：

- \`api.ts\` 不含任何 \`console.*\`，只返回結構化數據或 \`string[]\`。
- \`getdb.ts\` 不寫 SQL，只調 API 並打印。
- 新加的命令行工具只需 \`import\` \`api.ts\`，不必重複查詢邏輯。
