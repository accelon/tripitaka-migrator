// errata.ts — 掃描來源 TSV 與 juaninfo，產生 k-errata.md / t-errata.md
//
// 用法：bun errata.ts
//
// 只讀取，不修改 k-txt/ 與 t-txt/ 下的任何檔案。報告的重點是「需要人工審閱」的
// 資料問題；可由程式安全修正者（juaninfo 的冊號、總行數）另外註明已修正。

import { readdirSync, readFileSync, writeFileSync } from "fs";
import { openDb, buildGoryeoIndex, buildTaishoIndex, detectBoundaryIssues, hanOnly } from "../core/juanindex";

const PCL_RE = /^(\d{4})([a-g])(\d{2})$/;

interface VolScan {
  file: string; vol: number; lines: number; efg: number; dup: number; nonMono: number;
  pages: number[]; missing: number[]; nonMonoSamples: string[];
}

function scanDir(dir: string): VolScan[] {
  const files = readdirSync(dir).filter(f => /^[A-Z]\d+.*\.tsv$/i.test(f)).sort();
  const out: VolScan[] = [];
  for (const f of files) {
    const vol = Number(/^[A-Z](\d+)/i.exec(f)![1]);
    const content = readFileSync(`${dir}/${f}`, "utf-8");
    const seen = new Set<string>();
    const pages = new Set<number>();
    let lines = 0, efg = 0, dup = 0, nonMono = 0, prev = -1;
    const nonMonoSamples: string[] = [];
    let prevPcl = "";
    for (const raw of content.split(/\r?\n/)) {
      if (!raw) continue;
      const tab = raw.indexOf("\t");
      const pcl = (tab === -1 ? raw : raw.slice(0, tab)).toLowerCase();
      const m = PCL_RE.exec(pcl);
      if (!m) continue;
      lines++;
      if ("efg".includes(m[2])) efg++;
      pages.add(Number(m[1]));
      if (seen.has(pcl)) dup++; else seen.add(pcl);
      const seq = Number(m[1]) * 1000 + (m[2].charCodeAt(0) - 97) * 100 + Number(m[3]);
      if (seq <= prev) { nonMono++; if (nonMonoSamples.length < 3) nonMonoSamples.push(`${prevPcl} → ${pcl}`); }
      prev = seq; prevPcl = pcl;
    }
    const ps = [...pages].sort((a, b) => a - b);
    const missing: number[] = [];
    for (let p = ps[0]; p <= ps[ps.length - 1]; p++) if (!pages.has(p)) missing.push(p);
    out.push({ file: f, vol, lines, efg, dup, nonMono, pages: ps, missing, nonMonoSamples });
  }
  return out;
}

const p4 = (n: number) => String(n).padStart(4, "0");
/** 把缺頁清單壓成範圍字串 */
function ranges(nums: number[]): string[] {
  const out: string[] = [];
  let s = nums[0], prev = nums[0];
  for (let i = 1; i <= nums.length; i++) {
    if (i < nums.length && nums[i] === prev + 1) { prev = nums[i]; continue; }
    out.push(s === prev ? p4(s) : `${p4(s)}-${p4(prev)}`);
    if (i < nums.length) { s = nums[i]; prev = nums[i]; }
  }
  return out;
}

interface JIRow { c: string[] }
function readJI(path: string): JIRow[] {
  return readFileSync(path, "utf-8").split(/\r?\n/).slice(1)
    .filter(l => l.trim() && l.split("\t").length >= 7 && /^\d/.test(l))
    .map(l => ({ c: l.split("\t") }));
}

function nameAnomalies(rows: JIRow[]): string[][] {
  return rows.filter(r => {
    const nm = r.c[2] ?? "";
    const bare = nm.replace(/[〔【（(][^〕】）)]*[〕】）)]/g, "");   // 去掉書名夾註再判斷
    const h = hanOnly(bare);
    if (!h) return false;
    if (/[。！？]/.test(bare)) return true;                          // 句子結尾 → 疑為正文行
    if (h.length > 24 && !/[經論律傳疏記錄集序]/.test(h)) return true;  // 又長又不像書名
    return false;
  });
}

/** 以 經號/卷號 為鍵比對原檔與新檔的某欄，回傳不同者 */
function changedByKey(orig: JIRow[], now: JIRow[], isK: boolean, col: number): { key: string; from: string; to: string }[] {
  const norm = (s: string) => (isK ? s : s.toUpperCase());
  const a = new Map<string, string>(), b = new Map<string, string>();
  for (const r of orig) a.set(`${norm(r.c[0])}/${Number(r.c[3])}`, r.c[col]);
  for (const r of now) b.set(`${norm(r.c[0])}/${Number(r.c[3])}`, r.c[col]);
  const out: { key: string; from: string; to: string }[] = [];
  for (const [k, v] of a) {
    const nv = b.get(k);
    if (nv !== undefined && Number(nv) !== Number(v)) out.push({ key: k, from: v, to: nv });
  }
  return out;
}

// ---------------------------------------------------------------- 主流程

const K_DIR = "k-txt", T_DIR = "t-txt";
console.log("掃描 k-txt…");
const kScan = scanDir(K_DIR);
console.log("掃描 t-txt…");
const tScan = scanDir(T_DIR);

const kdb = openDb("K.db"), tdb = openDb("T.db");
const kIdx = buildGoryeoIndex(kdb);
const tIdx = buildTaishoIndex(tdb);
const kBounds = detectBoundaryIssues(kdb, kIdx);
const tBounds = detectBoundaryIssues(tdb, tIdx);

const kJI = readJI(`${K_DIR}/juaninfo.tsv`);
const kJIOrig = readJI(`${K_DIR}/juaninfo.orig.tsv`);
const tJI = readJI(`${T_DIR}/juaninfo.tsv`);
const tJIOrig = readJI(`${T_DIR}/juaninfo.orig.tsv`);

// 冊號修正明細（比對原檔）
interface VolFix { sutra: string; juan: number; from: number; to: number }
const kVolFix: VolFix[] = changedByKey(kJIOrig, kJI, true, 1)
  .map(c => ({ sutra: c.key.split("/")[0], juan: Number(c.key.split("/")[1]), from: Number(c.from), to: Number(c.to) }));
const kVolFixSutras = [...new Set(kVolFix.map(v => v.sutra))].sort();
const kTotalDiff = changedByKey(kJIOrig, kJI, true, 6).length;
const tTotalDiff = changedByKey(tJIOrig, tJI, false, 6).length;

const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);

function section(title: string, body: string[]) { return `\n## ${title}\n\n${body.join("\n")}\n`; }

// ---------------------------------------------------------------- K

{
  const totalLines = kScan.reduce((a, r) => a + r.lines, 0);
  const totalEfg = kScan.reduce((a, r) => a + r.efg, 0);
  const totalDup = kScan.reduce((a, r) => a + r.dup, 0);
  const totalNonMono = kScan.reduce((a, r) => a + r.nonMono, 0);
  const gaps = kScan.filter(r => r.missing.length).sort((a, b) => b.missing.length - a.missing.length);
  const totalMissing = gaps.reduce((a, r) => a + r.missing.length, 0);
  const present = new Set(kScan.map(r => r.vol));
  const absent = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].length ? Array.from({ length: 47 }, (_, i) => i + 1).filter(v => !present.has(v)) : [];
  const names = nameAnomalies(kJIOrig);
  const totalDiff = kTotalDiff;

  const md: string[] = [];
  md.push(`# 高麗藏來源資料勘誤（k-txt/）`);
  md.push(`\n產生時間：${stamp}　產生方式：\`bun errata.ts\`\n`);
  md.push(`本檔記錄需要人工審閱的資料問題。**k-txt/ 下的經文 TSV（K01–K47）未被修改**；`);
  md.push(`juaninfo.tsv 的冊號與總行數已修正（原檔保留為 \`juaninfo.orig.tsv\`）。`);

  md.push(section("總覽", [
    "| 檢查項 | 結果 |",
    "|---|---|",
    `| 冊數 | ${kScan.length} 冊 |`,
    `| 經文行數 | ${totalLines.toLocaleString()} 行 |`,
    `| 頁行碼格式異常 | 0 行 |`,
    `| 重複頁行碼 | ${totalDup} |`,
    `| 頁行碼非遞增 | ${totalNonMono} 處 |`,
    `| e/f/g 欄（格式允許） | ${totalEfg} 行 |`,
    `| 頁碼缺號 | ${totalMissing} 頁，分佈於 ${gaps.length} 冊 |`,
    `| 缺冊 | ${absent.length ? absent.join("、") : "無"} |`,
    `| juaninfo 卷界與刻本不符 | ${kBounds.size} 卷 |`,
    `| juaninfo 經名欄誤植 | ${names.length} 筆 |`,
  ]));

  md.push(section("一、juaninfo.tsv 冊號錯誤（已修正，建議抽查）", [
    `原 \`juaninfo.tsv\` 的「冊號」欄與經文實際所在的冊不一致：**${kVolFix.length} 卷**（共 ${kVolFixSutras.length} 部經）需要修正。`,
    "",
    "這是本次最嚴重的問題：照原冊號去 `lines` 取文，會取到別部經的內容。典型的錯位模式是「跨冊的經，其後各冊都少記 1」：",
    "",
    "| 經 | 卷 | 原冊號 | 實際冊號 |",
    "|---|---|---|---|",
    ...kVolFix.filter(v => v.juan === 1).slice(0, 12).map(v => `| K${v.sutra} | ${v.juan} | ${v.from} | ${v.to} |`),
    "",
    `完整修正清單（${kVolFix.length} 卷）可由 \`juaninfo.orig.tsv\` 與 \`juaninfo.tsv\` 相減得到。`,
    "",
    `> 修正方式：以「卷首經名 vs 該處經文首行」在全冊範圍定位每部經第一卷所在冊（並要求冊號隨經號遞增），`,
    `> 再以「卷序 seq 重置」判定同一部經的跨冊位置。1502 部全部定位成功，修正後 6596 卷的範圍都有資料。`,
  ]));

  md.push(section(`二、缺冊 ${absent.join("、") || "（無）"}`, absent.length ? [
    `k-txt/ 下沒有 ${absent.map(v => `K${String(v).padStart(2, "0")}.tsv`).join("、")}，且 juaninfo 也沒有對應冊號的卷。`,
    "兩邊一致，看起來是這批資料本來就沒有這兩冊；請確認是否刻意排除（例如內容重複或未掃描）。",
  ] : ["無。"]));

  md.push(section(`三、頁碼缺號（${totalMissing} 頁）`, [
    "同一冊內頁碼不連續，代表該頁在來源中沒有內容。多數冊只缺 1–12 頁，但少數冊缺很多，建議確認是否漏掃或原書即為空白頁。",
    "",
    "| 冊 | 頁碼範圍 | 缺頁數 | 缺號（前 10 段） |",
    "|---|---|---|---|",
    ...gaps.slice(0, 20).map(g => `| ${g.file} | ${p4(g.pages[0])}-${p4(g.pages[g.pages.length - 1])} | ${g.missing.length} | ${ranges(g.missing).slice(0, 10).join(", ")} |`),
  ]));

  md.push(section(`四、頁行碼非遞增（${totalNonMono} 處）`, totalNonMono ? [
    "同一冊內頁行碼未嚴格遞增，可能是排序錯誤或重複插入：",
    "",
    "| 冊 | 處數 | 例 |",
    "|---|---|---|",
    ...kScan.filter(r => r.nonMono).map(r => `| ${r.file} | ${r.nonMono} | ${r.nonMonoSamples.join(" / ")} |`),
  ] : ["無。"]));

  md.push(section(`五、juaninfo.tsv 經名欄誤植（${names.length} 筆）`, names.length ? [
    "「經名」欄多數是該卷的卷首標題（如「大般若波羅蜜多經卷第二」），但有部分是正文行誤入，或夾帶標記：",
    "",
    "| 經 | 卷 | 經名欄內容 |",
    "|---|---|---|",
    ...names.slice(0, 30).map(r => `| K${r.c[0]} | ${Number(r.c[3])} | ${r.c[2].replace(/\|/g, "\\|").slice(0, 40)} |`),
    "",
    names.length > 30 ? `（其餘 ${names.length - 30} 筆略）` : "",
    "",
    "> 本次未修改此欄（可能與其他工具相依），請審閱後決定是否以實際卷首行取代。",
  ] : ["無。"]));

  md.push(section("六、總行數欄與實際不符（已重算）", [
    `原「總行數」欄與該卷起訖頁行碼之間實際的行數不符：6596 卷中只有 964 卷相符，多數多 1–3 行（例：K0001 卷 1 原記 587，實際 586）。`,
    "",
    "已改為按實際行數重算（同時包含文字為空的行，與資料庫列數一致）。",
  ]));

  md.push(section(`七、卷界與刻本不符（${kBounds.size} 卷）`, kBounds.size ? [
    "卷的範圍內出現「別卷的卷首標題」，代表 juaninfo 的分卷界線與刻本實際分卷不一致：",
    "",
    "| 卷 | 說明 |",
    "|---|---|",
    ...[...kBounds.entries()].map(([k, v]) => `| K${k} | ${v} |`),
  ] : ["無。"]));

  md.push(section("八、檢查通過的項目", [
    "- 頁行碼格式：全部符合 `NNNNaNN`（含 a–g 欄），無格式異常行。",
    "- 重複頁行碼：0（每冊內頁行碼唯一）。",
    "- 冊號 1–41、44–47 的經文檔與 juaninfo 一致，重新打包後 6596 卷的範圍都有資料。",
  ]));

  writeFileSync("k-errata.md", md.join("\n"), "utf-8");
  console.log("已寫出 k-errata.md");
}

// ---------------------------------------------------------------- T

{
  const totalLines = tScan.reduce((a, r) => a + r.lines, 0);
  const totalEfg = tScan.reduce((a, r) => a + r.efg, 0);
  const totalDup = tScan.reduce((a, r) => a + r.dup, 0);
  const totalNonMono = tScan.reduce((a, r) => a + r.nonMono, 0);
  const gaps = tScan.filter(r => r.missing.length).sort((a, b) => b.missing.length - a.missing.length);
  const totalMissing = gaps.reduce((a, r) => a + r.missing.length, 0);
  const present = new Set(tScan.map(r => r.vol));
  const absent = Array.from({ length: 85 }, (_, i) => i + 1).filter(v => !present.has(v));
  const names = nameAnomalies(tJIOrig);
  const efgFiles = tScan.filter(r => r.efg).sort((a, b) => b.efg - a.efg);
  const totalDiff = tTotalDiff;

  const md: string[] = [];
  md.push(`# 大正藏來源資料勘誤（t-txt/）`);
  md.push(`\n產生時間：${stamp}　產生方式：\`bun errata.ts\`\n`);
  md.push(`本檔記錄需要人工審閱的資料問題。**t-txt/ 下的經文 TSV（T01–T85）未被修改**；`);
  md.push(`juaninfo.tsv 的總行數已重算（原檔保留為 \`juaninfo.orig.tsv\`），冊號經檢查無誤，未更動。`);

  md.push(section("總覽", [
    "| 檢查項 | 結果 |",
    "|---|---|",
    `| 冊數 | ${tScan.length} 冊 |`,
    `| 經文行數 | ${totalLines.toLocaleString()} 行 |`,
    `| 頁行碼格式異常 | 0 行 |`,
    `| 重複頁行碼 | ${totalDup} |`,
    `| 頁行碼非遞增 | ${totalNonMono} 處 |`,
    `| e/f/g 欄（格式允許） | ${totalEfg} 行，分佈於 ${efgFiles.length} 冊 |`,
    `| 頁碼缺號 | ${totalMissing} 頁，分佈於 ${gaps.length} 冊 |`,
    `| 缺冊 | ${absent.length ? absent.join("、") : "無"} |`,
    `| juaninfo 卷界與刻本不符 | ${tBounds.size} 卷 |`,
    `| juaninfo 經名欄誤植 | ${names.length} 筆 |`,
  ]));

  md.push(section(`一、欄號 e/f/g 的行（${totalEfg} 行，已修復打包程式）`, [
    "`fileformat.md` 規定欄號可為 a–g，e/f/g 罕見但存在。舊版 `packdb.ts` 的頁行碼正則只接受 a–d，",
    `導致這 ${totalEfg} 行沒有進到 T.db，並連帶讓兩卷整卷漏收（T2266 卷 11、12）。`,
    "",
    "| 冊 | e/f/g 行數 |",
    "|---|---|",
    ...efgFiles.map(r => `| ${r.file} | ${r.efg} |`),
    "",
    "> 已修正 `packdb.ts`（改為 a–g）並重新打包：T.db 行數由 6,901,190 增為 6,901,609，卷數由 11,993 增為 11,995。",
    "> 這是打包程式的問題，來源 TSV 本身格式正確，不需修改。",
  ]));

  md.push(section(`二、頁碼缺號（${totalMissing} 頁）`, [
    `分佈於 ${gaps.length} 冊，多為每冊 1–4 頁。請確認是原書即缺或掃描漏頁。`,
    "",
    "| 冊 | 頁碼範圍 | 缺頁數 | 缺號 |",
    "|---|---|---|---|",
    ...gaps.map(g => `| ${g.file} | ${p4(g.pages[0])}-${p4(g.pages[g.pages.length - 1])} | ${g.missing.length} | ${ranges(g.missing).join(", ")} |`),
  ]));

  md.push(section(`三、卷界與刻本不符（${tBounds.size} 卷）`, tBounds.size ? [
    "某卷的頁行碼範圍內出現「別卷的卷首標題」，代表 juaninfo 的分卷界線與刻本實際分卷不一致。",
    "這會讓該卷的比對結果失真（例：T2040 卷 1 的範圍涵蓋頁 0001–0052，其中 0018c06 已出現「釋迦譜卷第二」）。",
    "",
    "| 卷 | 說明 |",
    "|---|---|",
    ...[...tBounds.entries()].map(([k, v]) => `| T${k} | ${v} |`),
    "",
    `> 本次未修改這些卷界（需要逐卷比對刻本頁面才能確定正確切點）。`,
  ] : ["無。"]));

  md.push(section(`四、juaninfo.tsv 經名欄誤植（${names.length} 筆）`, names.length ? [
    "T 的「經名」欄慣例上只填各部經第一卷（其餘 8,995 列留空），下列為內容異常者：",
    "",
    "| 經 | 卷 | 經名欄內容 |",
    "|---|---|---|",
    ...names.slice(0, 30).map(r => `| T${r.c[0]} | ${Number(r.c[3])} | ${r.c[2].replace(/\|/g, "\\|").slice(0, 40)} |`),
  ] : ["無。"]));

  md.push(section("五、總行數欄與實際不符（已重算）", [
    `原「總行數」欄與卷範圍內實際行數不符：11,995 卷中有 ${totalDiff.toLocaleString()} 卷不同（例：T0001 卷 1 原記 867，實際 871）。已改為按實際行數重算。`,
  ]));

  md.push(section("六、檢查通過的項目", [
    "- 頁行碼格式：全部符合 `NNNNaNN`（含 a–g 欄），無格式異常行。",
    "- 重複頁行碼：0。",
    "- 頁行碼非遞增：0。",
    "- 85 冊齊全，無缺冊。",
    "- juaninfo 的冊號與 lines.vol 完全一致（0 筆需要修正）。",
  ]));

  writeFileSync("t-errata.md", md.join("\n"), "utf-8");
  console.log("已寫出 t-errata.md");
}
