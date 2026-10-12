# juanmap 任務：資料管線、比對結果與勘誤

對應 `juanmap.md`（分卷對照、相似度）與 `convert-sutra-pos.md` 的前置作業。
`convert-sutra-pos.md`（位置轉換模塊）的部分見 `posmap-notes.md`。

## 產出檔案

| 檔案 | 用途 |
|---|---|
| `makejuaninfo.ts` | 產生修正後的 `k-txt/juaninfo.tsv`、`t-txt/juaninfo.tsv`（舊檔備份為 `juaninfo.orig.tsv`） |
| `packdb.ts` | 打包：`bun packdb.ts k-txt K.db`、`bun packdb.ts t-txt T.db` |
| `juanindex.ts` | 共用資料層：讀 juan 表、對照表解析、取卷經文（含只取正文） |
| `similarity.ts` | 相似度演算法：Myers diff、正文／序言／附文判定 |
| `checkjuan.ts` | 任務 1：檢查兩藏卷數是否一致 → `checkjuan.tsv` |
| `comparejuan.ts` | 任務 2：逐卷比對 → `comparejuan.tsv` |
| `juanmarks.ts` | 每卷序言／附文起點 → `juan-prolog.tsv`、`juan-epilog.tsv` |
| `errata.ts` | 掃描來源 TSV／juaninfo 的資料問題 → `k-errata.md`、`t-errata.md` |
| `verify.ts` | 抽查單卷比對結果 |
| `sqlaccess.ts` / `sqlaccess.md` | 讀取 API（含「只讀正文」） |

## 用法

```bat
bun makejuaninfo.ts             :: 產生修正後的 juaninfo（--check 只檢查不寫檔）
bun packdb.ts k-txt K.db        :: 重新打包高麗藏
bun packdb.ts t-txt T.db        :: 重新打包大正藏
bun checkjuan.ts                :: 卷數檢查
bun comparejuan.ts --fresh      :: 逐卷比對（約 1.7 分鐘）
bun juanmarks.ts --fresh        :: 序言／附文標記（約 1.7 分鐘）
bun errata.ts                   :: 重新產生勘誤報告
bun verify.ts 0001 0220 1       :: 抽查
```

## 資料管線

```
k-txt/K01..K47.tsv ─┐
k-txt/juaninfo.tsv ─┴→ packdb.ts → K.db ─┐
                                          ├→ juanindex.ts / similarity.ts → 比對與標記
t-txt/T01..T85.tsv ─┐                    │
t-txt/juaninfo.tsv ─┴→ packdb.ts → T.db ─┘
```

### juaninfo 修正了什麼（`makejuaninfo.ts`）

1. **冊號**：原 K 的「冊號」欄與經文實際所在的冊不一致，**1674 卷**（40 部經）是錯的；
   照原值取文會取到別部經。T 的冊號經檢查正確，未動。
2. **總行數**：原欄位與卷範圍內的實際行數不符（K 只有 964/6596 卷相符），一律重算。
3. **新增 4 欄**：`序言行數`、`附文行數`、`序言字數`、`附文字數`。
   序言＝卷首只出現在單邊的區段，附文＝卷末同理；不在可比對範圍的卷填 0。
4. 經名、卷號、起點、終點維持原值（經名欄的誤植列於勘誤報告，未逕行修改）。

原檔保留為 `k-txt/juaninfo.orig.tsv`、`t-txt/juaninfo.orig.tsv`；舊版資料庫保留為
`k-txt/K.db`、`t-txt/T.db`（與修正前的根目錄版本位元組相同）。

### packdb.ts 修正了什麼

- 頁行碼欄號由 `a-d` 改為 **`a-g`**（`fileformat.md` 規定可到 g）。舊版因此丟掉 T 的
  **419 行**，並讓 **T2266 卷 11、12** 整卷沒進資料庫。修正後 T.db 由 6,901,190 行／
  11,993 卷增為 **6,901,609 行／11,995 卷**。
- 讀取 juaninfo 的新增 4 欄並寫入 `juan` 表。
- 可用第二個參數指定輸出檔（`bun packdb.ts k-txt K.db`），並在打包後檢查卷範圍是否有資料。

## 只讀正文的 API

`juan` 表多了 `preface_lines` / `appendix_lines` / `preface_chars` / `appendix_chars` 四欄。

```ts
import { openDb, PclByJuan, getJuan, getJuanBody, getJuanPreface, getJuanAppendix } from "./sqlaccess";

openDb("K.db");
PclByJuan("0001", 1);        // → { ..., total_lines: 586, preface_lines: 102, preface_chars: 1400, ... }
getJuan("0001", 1).length;   // 586
getJuanBody("0001", 1);      // 484 行，開頭是「大般若經初會序…」（已去掉《大唐三藏聖教序》）
getJuanPreface("0001", 1);   // 102 行
getJuanAppendix("0001", 1);  // []
```

以 `juanindex.ts` 為底層時：`readJuan(db, rec, { bodyOnly: true })`。

## 相似度演算法

1. **正規化**：只保留漢字（含擴充 A/B 區），標點、標記、數字、ASCII 一律剔除 → 滿足約束 2。
2. **對齊**：Myers O(ND) 最短編輯脚本（先去共同前後綴）。trace 只保留每個 d 實際用到的
   k 線，記憶體由 O(D·(N+M)) 降為 O(D²)，長卷（3 萬字）也能精確比對，不必退化。
3. **替代**：相鄰的刪除段與新增段按位置配對成「替代」，只有配對不上的多餘字數才算
   新增／刪除 → 滿足約束 3（「峰/峯」不計為差異）。
4. **正文邊界**：第一個「連續相同 ≥ 20 字」的片段之前算序文，最後一個之後算附文；
   前後段合計不足 12 字則不認定 → 滿足約束 1。
5. **指標**（只計正文）：
   - `相似度 = (相同 + 替代) / 對齊長度`
   - `嚴格相似度 = 相同 / 對齊長度`
   - 「相同」不到較短一邊的一半時記為「對齊粗略」——此時替代會吸收掉全部差異，
     相似度會虛高，必須看嚴格相似度。

## comparejuan.tsv 欄位

前 8 欄為 `juanmap.md` 指定，其後為附加資訊：

```
高麗經號 大正經號 卷數 漢字數 相似度 正文字數 序言字數 附文字數
新增字數 刪除字數 替代字數 嚴格相似度 大正漢字數 正文起點K 正文起點T 備註
```

- 漢字數／正文字數指高麗藏該卷。
- 序言字數、附文字數為帶正負號整數：`+N` 表示高麗藏沒有、大正藏有的字數；`-N` 表示
  高麗藏有而大正藏刪去的字數；0 顯示為 `0`。

## 序言／附文標記檔

`juan-prolog.tsv`：`高麗經號 大正經號 卷數 | 高麗序言起點 終點 字數 | 大正序言起點 終點 字數 | 類型 備註`
`juan-epilog.tsv`：同上，改為附文。

- 起點／終點為頁行碼 pcl；該側沒有時填 `-`。
- **類型**：`無` / `卷首題記`（`卷末題記`）/ `序言`（`附文`）。真正的序言／附文需同時滿足
  該區最大長度 ≥ 100 字，且區內兩藏完全相同的字數不到該長度的一半——否則只是被分段
  邊界吸收的正文或經名、譯者、卷末卷題這類題記。

## 勘誤報告

`k-errata.md`、`t-errata.md`（由 `errata.ts` 產生，只讀取來源，不修改 k-txt/、t-txt/ 下的經文 TSV）。

| 項目 | K | T |
|---|---|---|
| 冊數／行數 | 45 冊 / 3,413,757 行 | 85 冊 / 6,901,609 行 |
| 頁行碼格式異常 | 0 | 0 |
| 重複頁行碼 | 0 | 0 |
| 頁行碼非遞增 | 2 處（K22、K37） | 0 |
| e/f/g 欄 | 0 | 419 行（舊 packdb 漏收，已修） |
| 頁碼缺號 | 617 頁 / 17 冊 | 80 頁 / 54 冊 |
| 缺冊 | 42、43 | 無 |
| juaninfo 卷界與刻本不符 | 1 卷 | 181 卷 |
| juaninfo 經名欄誤植 | 6 筆 | 9 筆 |

其中「juaninfo 冊號錯誤」（1674 卷）與「總行數不符」已修正；頁碼缺號、缺冊、
卷界與刻本不符、經名誤植等需要人工審閱，詳見報告。

## 執行結果摘要

**任務 1**（`checkjuan.ts`，約 1 秒）

| 類別 | 部數 |
|---|---|
| 卷數一致 | 1475 |
| 卷數不一致 | 5（K0136、K1152、K1199、K1396、K1482） |
| 合刊 | 1（K1224，高麗 1 卷合 12 部大正經） |
| 局部對應 | 5（K0016、K0059、K0071、K0411、K0894） |
| 無對照／大正缺此經 | 16 |

**任務 2**（`comparejuan.ts`，6360 卷約 1.7 分鐘）

- 1475 部經、6360 卷；高麗 45,683,915 漢字 vs 大正 45,957,270 漢字。
- 相似度：中位數 0.9996、p1 = 0.9837；4199 卷 ≥ 0.999，僅 14 卷 < 0.5。
- 嚴格相似度中位數 0.9658。
- 141 卷有備註：107 卷兩藏字數懸殊、27 卷對齊粗略、6 卷大正卷界存疑、1 卷高麗卷界存疑。

**序言／附文標記**（`juanmarks.ts`）

| | 序言/附文 | 題記 | 無 |
|---|---|---|---|
| `juan-prolog.tsv` | 170 卷 | 4032 卷 | 2158 卷 |
| `juan-epilog.tsv` | 293 卷 | 3795 卷 | 2272 卷 |

重新打包後重跑，`juan-prolog.tsv`／`juan-epilog.tsv` 與修正前完全一致；
`comparejuan.tsv` 只有 1 列不同且是變好：K1055/2 ↔ T2034/2 因補回 T 被漏收的 136 字，
刪除字數由 139 降為 3，相似度由 0.9696 升為 0.9985。
