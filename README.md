# 高麗藏 ⇄ 大正藏　位置轉換表

給定一個大正藏位址，直接給出高麗藏（再雕本）的對應位址；反向亦然。
把「翻書比對」換成「一行指令」。

涵蓋 **1,474 部經、6,357 卷、4,590 萬漢字**。

---

## 要解決的問題

高麗藏與大正藏收錄大量相同的典籍，但**同樣的文字落在兩套書的不同位置**——
分卷不同、每頁行數不同、斷行不同、用字也有差異（高麗藏用韓國漢字，大正藏用日本漢字）。

研究者引用高麗藏時，往往需要先找到它在《大正藏》的對應位置，才能與既有的研究文獻接軌。
傳統做法是翻書逐頁比對，一個位置要花幾分鐘。

## 成果

| 項目 | 數值 |
|---|---|
| 涵蓋 | 1,474 部經 / 6,357 卷 |
| 經文總量 | 45,903,703 漢字 |
| **對照資產** | **1,618,468 bytes（1.54 MB）** |
| 轉換一個位置 | 約 27 ms（含行程啟動） |
| 全藏建置 | 約 2 分鐘 |

對照表只記錄「哪一段對應哪一段」，**不重存經文**——這是體積能壓到 1.54 MB 的原因。
經文本身仍來自兩份既有的資料庫（高麗藏 391 MB、大正藏 808 MB），
對照資產可以獨立散布，也可以內嵌進單一網頁。

## 快速開始

### 圖形介面（免安裝）

`public/tripitaka-migrator.html` 是**單一 HTML 檔**（2.5 MB），
雙擊即用、離線可跑、手機可用，不需伺服器、不連外網。資料全部內嵌。

也可以用滑鼠逐層選取（冊 → 經 → 卷 → 頁 → 欄 → 行），或直接貼上位址。

### 命令列

`poscli.exe`（Windows，單一執行檔）**不提供下載**，需要批次處理者請加微信 `Sukhanika` 索取。

### 程式庫

```ts
import { openPosSource } from "./src/core/posdb";
import { convertTaishoGoryeo } from "./src/core/posmap";

const db = openPosSource("posmap.db");
const r = convertTaishoGoryeo(db, { vol: 8, page: 748, col: "c", line: 24, off: 0 });
```

## 專案結構

```
README.md
docs/                     說明、報告、勘誤
tables/                   分析與驗證產生的表（TSV）
src/
  core/                   核心：位址格式、對齊演算法、二進位容器、SQLite 存取
  build/                  建置管線：文字 → 資料庫 → 對齊 → 可攜資產
  scrape/                 網路抓取（東國大學 KABC、SAT）
  web/                    前端產生器與樣板
  check/                  驗證與比對工具
  lab/                    實驗性程式（不納入版控）
public/                   成品：單頁應用與簡報
gopos/                    Go 命令列工具（單一執行檔、資產內嵌）

資料（體積大或屬原始數據，不納版控）：
cbeta/  goryeo-raw-html/  sat-raw-html/     CBETA、東國大學、SAT 原文
k-txt/  t-txt/                              兩藏逐行文字（juaninfo.tsv 除外）
k-txt.old/                                  補漏前的舊資料，保留供對照
K.db  T.db  posmap.db                       打包與對齊資料庫
```

`tables/` 內的檔案由各工具產生（例如 `postest.ts` → `tables/postest-cases.tsv`），
是報告與勘誤的證據來源，可重新產生。

> 各藏的分卷表 `k-txt/juaninfo.tsv`、`t-txt/juaninfo.tsv` **不在此列**——
> 它們是所屬資料集的一部分（同名、由 `makejuaninfo.ts`、`gen-goryeo2.ts` 寫入）。

## 建置流程

所有指令都在**專案根目錄**執行（工具以相對於工作目錄的路徑存取資料）。

```bash
# 1. 高麗藏：東國大學 KABC 原文 → goryeo-raw-html/
bun src/scrape/scrapg.ts plan          # 列出待抓清單
bun src/scrape/scrapg.ts fetch         # 抓取
bun src/scrape/scrapg.ts tail          # 依大正藏補漏

# 2. 高麗藏原文 → k-txt/（分卷以 k-txt/juaninfo.tsv 為準）
bun src/build/gen-goryeo2.ts

# 3. 大正藏：SAT 原文 → t-txt/
bun src/build/gen-sat.ts
bun src/build/makejuaninfo.ts          # 修正分卷、產生 juaninfo.tsv

# 4. 兩藏文字 → SQLite
bun src/build/packdb.ts                # 產生 K.db、T.db

# 5. 逐字對齊 → posmap.db 與 gopos/asset/posmap.pos（約 2 分鐘）
bun src/build/buildpos.ts --all

# 6. 產生單頁應用
bun src/web/gen-spa.ts                 # 產生 public/tripitaka-migrator.html
```

## 驗證

```bash
bun src/check/posselftest.ts    # 對齊演算法自測（45 項）
bun src/check/spacheck.ts       # 瀏覽器端與 Bun 端轉換結果對帳（400 點）
bun src/check/spauitest.ts      # 前端介面煙霧測試（模擬 DOM）
bun src/check/postest.ts        # 抽樣 1,949 個位置，逐點核對經文
```

## 不在版控內的資料

以下為原始數據、中間產物或體積過大者，**不納入版控**，需自行取得或重新產生：

| 項目 | 說明 |
|---|---|
| `cbeta/` | CBETA TEI XML 原文 |
| `sat-raw-html/` | SAT 2018 原文 |
| `goryeo-raw-html/` | 東國大學 KABC 原文 |
| `k-txt/`、`t-txt/` | 兩藏逐行文字。**例外**：其中的 `juaninfo.tsv`（分卷表）已納入版控 |
| `K.db`、`T.db` | 由 `k-txt/`、`t-txt/` 打包而成 |
| `posmap.db` | 對齊資料庫（可由 `buildpos.ts` 重建） |
| `posdata/` | 對齊 JSON 中間檔（`buildpos.ts` 會重新產生） |
| `k-txt.old/` | 補漏前的舊資料，保留供對照 |

## 發行版

`public/` 內的成品以 GitHub Release 形式發布，內容為可直接開啟的 HTML，
下載後雙擊即可使用。

## 文件

| 文件 | 內容 |
|---|---|
| [posmap-report.md](docs/posmap-report.md) | 工程報告（方法、資料、發現） |
| [posmap-notes.md](docs/posmap-notes.md) | 建置過程的技術筆記 |
| [posmap-slides.md](docs/posmap-slides.md) | 給非程序員的簡報稿 |
| [fileformat.md](docs/fileformat.md) | 位址格式與二進位容器規格 |
| [sqlaccess.md](docs/sqlaccess.md) | 資料庫結構與查詢範例 |
| [t-errata.md](docs/t-errata.md) | 大正藏資料勘誤 |
| [k-errata.md](docs/k-errata.md) | 高麗藏資料勘誤 |
| [juanmap.md](docs/juanmap.md)、[juanmap-notes.md](docs/juanmap-notes.md) | 分卷對照與說明 |
| [convert-sutra-pos.md](docs/convert-sutra-pos.md) | 單經轉換工具說明 |

## 已知限制

- 對照以**刻本文字**為準；兩藏用字差異（韓國漢字／日本漢字）以變體正規化處理，
  不視為差異。
- 部分經典在兩藏中內容本身就有出入（古逸部、疑偽部尤多），這些位置沒有對應，
  工具會明示而非勉強對應。
- 序文、附文也納入分卷範圍；比對正文時另以 `bodyBounds` 排除。
- 少量經典的分卷與刻本不符，已記於 `docs/k-errata.md`、`docs/t-errata.md`，
  原始資料未逕行修改。

## 致謝

本表的建置與除錯，感謝 **DeepSeek Harness** 協助，省下大量人工排查與建表的時間。

---
