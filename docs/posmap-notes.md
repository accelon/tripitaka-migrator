# 位置轉換模塊（`convert-sutra-pos.md`）

把大正藏的位置換算成高麗藏的位置，精確到字。核心是「對齊資料庫」：事先把兩藏的
逐字對齊壓成精簡的位移差異表，查詢時只讀這張表，**不需要再碰 K.db / T.db，也不用重跑 diff**。

**全庫已完成**：1475 部經 / 6360 卷 / 高麗藏 45,683,915 漢字。
一份 `posmap.db`（19.7 MB）、一份 `posdata/`（1475 個網頁用 JSON，17.5 MB）、
以及一個單一執行檔 `gopos/poscli.exe`（9.78 MB，資料與演算法都編在裡面）。

## 產出檔案

| 檔案 | 用途 |
|---|---|
| `posfmt.ts` | 位址字串的解析／格式化、`gpos` 壓縮、varint 與 base64。純函式，無 Bun/Node 依賴 |
| `posmap.ts` | 對照核心：對齊資料的編碼解碼、位移查詢、`convertTaishoGoryeo` / `convertGoryeoTaisho`。純函式 |
| `posdb.ts` | 建置與讀取 `posmap.db`（Bun 端，`bun:sqlite`） |
| `posasset.ts` | 單一 binary asset（`posmap.pos`）的讀寫與 CRC 驗證 |
| `posweb.ts` | 網頁端入口：`fetch` 載入 JSON 後建出同一組介面 |
| `buildpos.ts` | CLI：建 `posmap.db`、匯出 `.pos` 與網頁 JSON |
| `posconvert.ts` | CLI：查位置，以及三種驗證（`--verify` / `--verify-asset` / `--verify-web`） |
| `posselftest.ts` | 單元自測（45 項） |
| `posestimate.ts` | 體積估算（抽樣外推） |
| `posdemo.html` / `posdemotest.ts` | 網頁示範與它的自動化測試 |
| **`gopos/`** | **Go 版：`poscli.exe`，資料用 `go:embed` 編進執行檔** |
| `posmap.db` | 對照資料庫（19.74 MB） |
| `posdata/*.json` | 網頁用對照檔（1475 檔 / 17.52 MB） |
| `webdist/posweb.js` | 瀏覽器 bundle |

## 用法

```bat
:: 查位置
bun posconvert.ts T01p0002c0405
bun posconvert.ts --show T01p0002c0405          :: 另印兩藏原文前後文

:: 只讀 JSON，完全不碰 .db（就是網頁那條路）
bun posconvert.ts --json posdata/0001.json T01p0002c0405

:: 驗證
bun posselftest.ts
bun posconvert.ts --verify                      :: 逐字驗證 posmap.db
bun posconvert.ts --verify-asset gopos/asset/posmap.pos
bun posconvert.ts --verify-web                  :: 驗證瀏覽器 bundle + 全部 JSON
bun posconvert.ts --emit-cases cases.tsv --sample 60
bun posdemotest.ts

:: 建庫
bun buildpos.ts --all --pos gopos/asset/posmap.pos --json posdata
bun buildpos.ts --from posmap.db --all --json posdata    :: 不重建，只重新匯出

:: Go 版
cd gopos && go build -o poscli.exe .
poscli.exe T01p0002c0405
poscli.exe info
poscli.exe verify cases.tsv
```

## 位址格式

沿用行業慣例，只加了一個必要的擴充：

```
T01p0002c0405    大正藏 第 1 冊 第 0002 頁 c 欄 第 04 行 第 05 個字之前
K17p0815a0301    高麗藏 第 17 冊 第 0815 頁 a 欄 第 03 行 第 01 個字之前
T01p0002c04      偏置為 0 時可省略
T49p0024a17.118  偏置 ≥ 100 的長行，用點號接三位數
```

- 「第 N 個字之前」＝字串指標：0 在「如」左邊，1 在「如」右邊（＝「是」左邊）。
- 偏置**只數 CJK 表意字符**：標點、標記（`^p`、`^cm`、`^br`）、ASCII、IVS 異體字選擇符
  （U+E0100–E01EF）都不計，擴充 B 區的代理對算 1 個字。
- 行號固定取欄號後的**前兩位數字**，其餘為偏置，故 `c405` 是「行 40 偏置 5」。
  全庫實測行號最大 92（大正藏）、47（高麗藏），兩位數字足夠。
- 點號形式是必要的：大正藏有 6 行漢字數超過 99（最多 190 字，都在第 49 冊的表格類頁面），
  高麗藏 0 行。沒有這個擴充就得捨去那 6 行的精度。

例：`T01p0002c0405` → 大正 `0002c04` 行原文「遍見無所畏　三會弟子衆」，
偏置 5 指在「三」的左邊（全形空格不計），換算得 `K17p0816b1300`，
K 的 `0816b13` 行首字也是「三」。

## gpos：把位置塞進一個 Number

```
page 4 位、col 1 位（a=0…g=6）、line 2 位、off 3 位、vol 為高位

gpos = ((((vol * 10000 + page) * 8 + col) * 100 + line) * 1000 + off
```

最大約 2×10¹²，遠小於 2⁵³，是精確的安全整數；同一冊內 **gpos 的大小順序＝閱讀順序**。
`unpackGpos` 完全可逆（`posselftest.ts` 已驗）。

## 對照結構：source map 式的「位移差異表」

兩藏的差異只有三種：刪除、新增、替代。**替代是一對一的**（「峰/峯」「説/說」），
所以在編輯脚本裡把變動區塊的刪除與新增按位置配對成「替代」之後，整卷就化為一連串
**1:1 對應段**與其間的空隙——這就是 source map 的 `mappings`。

```
T 字元位移 x ──對應段──▶ K 字元位移 y ──行表──▶ 頁/欄/行 + 行內偏置
```

### 關鍵一步：合併首尾相接的段

段內 `k = t + (kStart − tStart)`，位移差 `d` 在段內不變。**純替代不改 d**，所以
「相同片段 → 替代 → 相同片段」這種序列的前後段必然首尾相接且 d 相同，可以合併成一段，
查詢結果一字不差。只有真正的插入／刪除（單邊多出字）才會留下段的邊界。

效果：`T0001` 卷 1 從 **801 段降到 9 段**，整庫 payload 從 21.5 MB 降到 **12.5 MB**。
（`posselftest.ts` 用隨機段序列對 200 組做過等價性驗證。）

一卷的對照資料只有兩樣東西：

1. **對應段**：`(tStart, kStart, len)` 三元組，依 tStart 遞增。查 x 用二分搜尋；
   x 落在空隙（單邊插文）時取最接近的左界，並回報「非精確對應」。
2. **行表**：該卷每一行的 `seq`（＝`page*1000 + col*100 + line`）與該行漢字數。
   兩者都是小差分，varint 後每行約 2 byte。

全卷的「哪一行在第幾個字」由此還原，因此**不需要文本**就能把字元位移化回頁欄行。
BLOB 佈局見 `posmap.ts` 開頭。

## 任務第 2 點：序文／附文的處理

```
輸入 T 位址 → 化成 T 全卷字元位移 x
  x < 正文起點 → x = 正文起點      （adjust = preface）
  x > 正文終點 → x = 正文終點      （adjust = appendix）
  → 對應段換算成 K 位移 → K 位址
回傳：korean_address、adjusted_taisho_address
```

**「要跳過」的判定沿用 `juanmarks.ts` 那條規則**（也是 `juan-prolog.tsv`／`juan-epilog.tsv`
「類型」欄的來源）：該區最大長度 ≥ 100 字，且區內兩藏完全相同的字數不到該長度的一半，
才算真正的、單邊的序言／附文。

這一步很要緊。若照 `similarity.ts` 的原始分段邊界直接裁切，會把**兩藏都有的卷末經題**
（例如 T0001 卷 1 末尾 37 字，只有「説/說」「縁/緣」這類異體字之差）誤判為附文，
那些位置就會被錯誤地拉回正文邊界。改用上述規則後，只有真正缺漏的段落才跳過。

還有兩種邊界情形會回報清楚：`empty-line`（輸入那一行整行沒有漢字，指針移到最近的
有字行）、`nearest-line`（該頁欄行不在資料庫中）。

| 輸入 | 高麗藏 | 修正後大正藏 | 說明 |
|---|---|---|---|
| `T01p0002c0405` | `K17p0816b1300` | 不變 | 正文，精確對應 |
| `T01p0001a0500` | `K17p0815a0300` | `T01p0001b1101` | 落在僧肇《長阿含經序》，移到正文第一字 |
| `T08p0266b2000` | `K05p0296a2408` | `T08p0265c2500` | 落在附文（高麗藏整段沒有），回到正文最後一字的右邊 |
| `T05p0001a0100` | `K01p0002b1204` | `T05p0001a0404` | 該行沒有漢字，且落在序文 |
| `T11p0613a2305` | `K06p0854b0200` | `T11p0613a2600` | 該行整行沒有漢字（`adjust = empty-line`） |

## 三種使用方式，同一份核心

`posmap.ts`、`posfmt.ts` 是純函式，**不 import 任何 Bun/Node 模組**，瀏覽器直接可用。

```ts
// Bun CLI / 伺服器：讀 posmap.db
import { openPosSource } from "./posdb";
import { convertTaishoGoryeo } from "./posmap";
const { source } = openPosSource("posmap.db");
convertTaishoGoryeo(source.align("0001", 1)!, "T01p0002c0405");
// { koryo: "K17p0816b1300", adjustedTaisho: "T01p0002c0405", exact: true, … }

// 網頁：只載入 JSON
import { loadSource, convertTaishoGoryeo } from "./webdist/posweb.js";
const src = await loadSource("./posdata/0001.json");
convertTaishoGoryeo(src.align("0001", 1)!, "T01p0002c0405");

// 單一執行檔（Go）：資料與演算法都編在裡面
//   poscli.exe T01p0002c0405
```

`convertTaishoGoryeo` 回傳 `ok / koryo / adjustedTaisho / tPcl / kPcl / tOff / kOff /
tGpos / kGpos / adjust / exact / note`。另有反向的 `convertGoryeoTaisho`。

## Go 版：`gopos/poscli.exe`

```
poscli T01p0002c0405 [更多位址…]     換算（convert 是預設命令）
poscli k2t K17p0816b1301             反向：高麗藏 → 大正藏
poscli info                          顯示內嵌 asset 的統計
poscli unpack -o posmap.raw          解成未壓縮容器
poscli pack -o out.pos -codec brotli 重新壓縮
poscli verify cases.tsv              跨實作對帳（Go vs Bun）
```

- 對照資料用 `go:embed` 編進執行檔，**執行時不需要任何外部檔案**
  （已把 exe 複製到空目錄單獨執行驗證）。
- 啟動＋解壓 12.5 MB＋CRC 檢查約 **74 ms**。
- 依賴只有 `github.com/klauspost/compress`（zstd）與 `github.com/andybalholm/brotli`，
  都是純 Go、無 cgo。`-asset <檔>` 可改用外部 asset。
- asset 版面見 `gopos/README.md`；解碼與換算與 TypeScript 版逐條對應。

### 跨實作對帳

`bun posconvert.ts --emit-cases cases.tsv --sample N` 產生期望值（每一卷每一行的行首與
偏置 0/1/5/37/99、雙向換算、以及不存在的頁碼與冊號），`poscli verify` 用 Go 重算並
**逐欄比較**（含 `adjust`、`exact`、`note` 等文字欄位）：

| 測資 | 筆數 | 不符 |
|---|---|---|
| 全 22 卷（T0001，逐行） | 136,198 | 0 |
| 全庫每 60 卷取 1（106 卷） | 507,964 | 0 |

## 驗證總表

| 驗證 | 範圍 | 結果 |
|---|---|---|
| `posselftest.ts` | 位址、gpos、varint、編碼、段合併等價 | 45 項通過 |
| `--verify` | 全庫 6360 卷、45,829,948 個字元位置 | 0 不符 |
| `--verify` 的獨立對帳 | 與 `comparejuan.tsv` 逐卷比對（新增/刪除/替代＋對應段結構） | 0 / 6360 卷 |
| `--verify-asset` | asset 對 DB，14,839,835 次位置比對 | 0 不符 |
| `--verify-web` | 瀏覽器 bundle + 全部 1475 個 JSON，3,965,724 次 | 0 不符 |
| `posdemotest.ts` | 示範頁邏輯（假 DOM） | 10 項通過 |
| `poscli verify` | Go vs Bun，507,964 筆逐欄 | 0 不符 |

全庫 `--verify` 的數字：相同字 43,604,538、替代字 1,837,140、T 有 K 無 388,270；
對齊不單調、K 落在正文外、來回轉換不一致、行表不符、位址層不符全部 0。
替代字前幾名為 `説→說`(297,542)、`縁→緣`(132,264)、`即→卽`(128,551)、`清→淸`(126,330)。

## 體積（全庫實測，MB = 10⁶ bytes）

| 存法 | 大小 |
|---|---|
| `posmap.db`（SQLite） | 19.74 MB |
| `.pos` payload（未壓縮） | **13.13 MB**（13,131,705 B） |
| **`.pos` 用 zstd（內嵌進 exe 的那份）** | **1.61 MB**（1,614,605 B） |
| `.pos` 用 brotli q11 | **1.54 MB**（1,541,812 B） |
| `.pos` 用 gzip（最佳） | 1.84 MB（1,840,129 B） |
| 網頁 JSON 全套（1475 檔，base64 明文） | 17.52 MB |
| `poscli.exe`（含內嵌 asset） | 9.79 MB |

- 建庫耗時 **108 秒**（6360 卷）。
- 內嵌用 **zstd**：與 brotli 只差 70 KB（4.5%），但 Bun 與 Go 都能讀也能寫，
  管線對稱、可互相驗證，重建只要一個命令。`poscli pack -codec brotli` 可隨時換成 brotli
  （Go 端的 `pack` 會重新讀回驗證 CRC）。
- 對照基準：這 6360 卷的高麗藏經文（UTF-8，含標點標記）157.5 MB；
  所以位置對照表是經文的**約 1%**（1.61 / 157.5）。
- 單卷 payload：中位數約 2.1 KB、平均約 2.0 KB（合併段之後；合併前是 3.6 KB）。

## 已知限制

1. **涵蓋範圍**：只做一對一且卷數相同的 1475 部經／6360 卷。卷數不一（5 部）、合刊
   （K1224）、局部對應（5 部，如 K0016 → T0220 第九會）、無對照（16 部）都還沒納入。
2. **卷界與刻本不符**：T 有 181 卷、K 有 1 卷的分卷界線與刻本不合（見 `t-errata.md`），
   這些卷的對照會在卷界附近偏掉。
3. **對齊粗略**：少數卷（T 全庫 27 卷）兩藏文字幾乎對不上，轉換結果僅供參考——
   結果的 `coarse` 旗標與 `note` 都會提醒。
4. **單邊插文**：落在只有一邊有的字上（如大正藏後人增補的考訂文字）沒有精確對應，
   取最接近的位置並回報 `exact = false`。
5. **行內偏置的粒度**：偏置只數漢字，所以指標無法落在兩個漢字之間的標點上——
   這是題目指定的定義。
6. **換 asset 要重新編譯**：內嵌資料改了就得 `go build` 一次（Go 的 embed 是編譯期行為）。
   臨時要換可用 `poscli -asset <檔>`。
