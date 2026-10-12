// gen-sat.ts — SAT 2018 原始 HTML → t-txt（一冊一 TSV）＋ 校勘記表
//
// 對應原本的 gen-sat-txt.js（那個檔案不在工作區，這裡重寫成純 Bun 版）。
//
// SAT raw 的每一行長這樣（前綴就是權威的頁欄行）：
//   T1169_.20.0678a25: 唵</span><span class="cm">引</span><span class="tx">左隷</span>…
//   ・<span class="cm">X</span> 是小字（悉曇音註），舊版轉成 ^cmX
//   ・<span class="tx">X</span> 是正文
//   ・<button class="ftntf" title="校勘記">N</button> 是校勘記 —— **舊版整個丟掉**，
//     這裡另外輸出 sat-notes.tsv（pcl、註號、註文），這是校勘研究的材料。
//
// 用法：
//   bun gen-sat.ts [--out t-txt] [--vol 20] [--report]

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from "fs";
import { join } from "path";

const RAW = "sat-raw-html";
const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const OUT = flag("--out", "t-txt")!;
const ONLY = flag("--vol");
const REPORT = argv.includes("--report");

const LINE_RE = /^T(\d+[A-Z]?)_\.(\d\d)\.(\d{4})([a-g])(\d{2}): ?(.*)$/;
const NOTE_RE = /<button class="ftntf" title="([^"]*)">(\d+)<\/button>/g;

interface Rec { sutra: string; vol: number; pcl: string; text: string }

function clean(s: string): string {
  return s
    .replace(NOTE_RE, "")                                  // 校勘記編號（已另存）
    .replace(/<span class="cm">([\s\S]*?)<\/span>/g, "^cm$1")
    .replace(/<span class="tx">([\s\S]*?)<\/span>/g, "$1")
    .replace(/<a name="[^"]*" class="al">/g, "")
    .replace(/<\/a>/g, "")
    .replace(/<span class="[^"]*">([\s\S]*?)<\/span>/g, "$1")
    .replace(/<br\s*\/?>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "〈").replace(/&gt;/g, "〉").replace(/&amp;/g, "&")
    .replace(/\s+$/, "");
}

function parseFile(path: string): { recs: Rec[]; notes: string[] } {
  const recs: Rec[] = [], notes: string[] = [];
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, sutra, volS, page, col, lineNo, body] = m;
    const pcl = page + col + lineNo;
    for (const n of body.matchAll(NOTE_RE)) notes.push([pcl, n[2], n[1]].join("\t"));
    recs.push({ sutra, vol: Number(volS), pcl, text: clean(body) });
  }
  return { recs, notes };
}

// ---------------------------------------------------------------- 主流程

const t0 = Date.now();
const vols = readdirSync(RAW).filter(d => /^T\d\d/.test(d) && (!ONLY || d === `T${ONLY.padStart(2, "0")}`)).sort();
const byVol = new Map<number, Map<string, Rec>>();      // vol → pcl → rec
const notesOut: string[] = ["pcl\t註號\t校勘記"];
const sutraSeen = new Map<string, Set<number>>();
let nFile = 0, nLine = 0;

for (const v of vols) {
  const dir = join(RAW, v);
  let files: string[]; try { files = readdirSync(dir).filter(f => f.endsWith(".html")); } catch { continue; }
  for (const f of files) {
    nFile++;
    const { recs, notes } = parseFile(join(dir, f));
    notesOut.push(...notes);
    for (const r of recs) {
      nLine++;
      if (!byVol.has(r.vol)) byVol.set(r.vol, new Map());
      const m = byVol.get(r.vol)!;
      const prev = m.get(r.pcl);
      // 同一個 pcl 可能被多個 chunk 檔覆蓋；取文字較長者（避免抓到截斷的版本）
      if (!prev || r.text.length > prev.text.length) m.set(r.pcl, r);
      if (!sutraSeen.has(r.sutra)) sutraSeen.set(r.sutra, new Set());
      sutraSeen.get(r.sutra)!.add(r.vol);
    }
  }
}

mkdirSync(OUT, { recursive: true });
const seqOf = (pcl: string) => Number(pcl.slice(0, 4)) * 1000 + (pcl.charCodeAt(4) - 97) * 100 + Number(pcl.slice(5));
let total = 0;
const written: number[] = [];
for (const [vol, m] of [...byVol].sort((a, b) => a[0] - b[0])) {
  const lines = [...m.values()].sort((a, b) => seqOf(a.pcl) - seqOf(b.pcl))
    .map(r => `${r.pcl}\t${r.text}`);
  writeFileSync(join(OUT, `T${String(vol).padStart(2, "0")}.tsv`), lines.join("\n") + "\n");
  total += lines.length; written.push(vol);
}
writeFileSync("tables/sat-notes.tsv", notesOut.join("\n") + "\n");

console.log(`【完成】${nFile} 個 raw 檔、${nLine.toLocaleString()} 行 → ${written.length} 冊、${total.toLocaleString()} 行`);
console.log(`       校勘記 ${(notesOut.length - 1).toLocaleString()} 條 → sat-notes.tsv`);
console.log(`       經號 ${sutraSeen.size} 部；耗時 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

// ---------------------------------------------------------------- 對帳報告
if (REPORT) {
  // 與現有 t-txt 比對：哪些 pcl 是 raw 有而現有 t-txt 沒有（漏抓）
  let missNew = 0, missOld = 0, diff = 0;
  const samples: string[] = [];
  for (const vol of written) {
    const cur = join(OUT, `T${String(vol).padStart(2, "0")}.tsv`);
    const old = join("t-txt", `T${String(vol).padStart(2, "0")}.tsv`);
    if (!existsSync(old)) continue;
    const a = new Map<string, string>(), b = new Map<string, string>();
    for (const l of readFileSync(cur, "utf-8").split(/\r?\n/)) { const i = l.indexOf("\t"); if (i > 0) a.set(l.slice(0, i), l.slice(i + 1)); }
    for (const l of readFileSync(old, "utf-8").split(/\r?\n/)) { const i = l.indexOf("\t"); if (i > 0) b.set(l.slice(0, i), l.slice(i + 1)); }
    for (const [p, t] of a) { if (!b.has(p)) missNew++; else if (b.get(p) !== t) { diff++; if (samples.length < 6) samples.push(`T${vol} ${p} | 新:${t.slice(0, 40)} | 舊:${(b.get(p) ?? "").slice(0, 40)}`); } }
    for (const p of b.keys()) if (!a.has(p)) missOld++;
  }
  console.log(`\n【對帳】raw 有、現有 t-txt 沒有：${missNew.toLocaleString()} 行`);
  console.log(`       現有 t-txt 有、raw 沒有：${missOld.toLocaleString()} 行`);
  console.log(`       同 pcl 文字不同：${diff.toLocaleString()} 行`);
  samples.forEach(s => console.log("   " + s));
}
