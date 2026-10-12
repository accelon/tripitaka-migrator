// gen-goryeo.ts — 把 goryeo-raw-html 的原始抓取結果轉成 k-txt（每冊一個 TSV）＋ juaninfo
//
// 這是原本 gen-goryeo.ts 的純 Bun 重寫版，差異：
//   1. 輸入路徑 goryeo-raw-html/（不再依賴 ptk 套件）
//   2. 同時讀取補抓檔 goryeo-raw-html/fill-<經號>.html，與主檔合併
//   3. 卷界由「^j<N> 標記所在的下一個 pcl」決定；同一卷若有多個標記，取 pcl 最小者
//      → 補抓回卷首的頁時，卷界會自動往前移
//
// 用法：
//   bun gen-goryeo.ts [--out k-txt] [--sutra 0647]

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const RAW = "goryeo-raw-html";
const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const OUT = flag("--out", "k-txt")!;
const ONLY = flag("--sutra");

/** 一行的來源 */
interface Line { vol: number; pcl: string; seq: number; text: string; juan: number; sutra: string }
const seqOf = (pcl: string) => {
  const m = /^(\d{4})([a-g])(\d{2})$/.exec(pcl);
  return m ? Number(m[1]) * 1000 + (m[2].charCodeAt(0) - 97) * 100 + Number(m[3]) : -1;
};

/** 從主檔（HTML）抽行；^j<N> 標記會改變後續行的卷號。補抓檔是「pcl\t文字」格式，同一支處理 */
const LINE_RE = /data-xsl-lineid="(\d{3})_(\d{4})_([abc])_(\d{2})L"[^>]*>[\s\S]*?<\/span>([\s\S]*?)(?=<span data-xsl-lineid|$)/g;
function parseHtml(content: string, sutra: string): Line[] {
  const out: Line[] = [];
  // 依 ^jN 標記切成一段一段（標記在檔案裡是獨立一行）
  const chunks = content.split(/(?:^|\n)\^j(\d+)[ \t]*(?=\r?\n|$)/);
  const emit = (body: string, juan: number) => {
    if (!body || !body.trim()) return;
    if (body.includes('data-xsl-lineid="')) {
      // HTML：必須整段攤平，行內文字會跨實體換行
      const flat = body.replace(/\r?\n/g, "");
      LINE_RE.lastIndex = 0;
      for (const m of flat.matchAll(LINE_RE)) {
        const pcl = m[2] + m[3] + m[4];
        const text = m[5]
          .replace(/<br data-xsl-tag="p">/g, "^p")
          .replace(/<br[^>]*>/g, "")
          .replace(/<span data-jusok-type="원주"[^>]*>([\s\S]*?)<\/span>/g, "^half〔$1〕")
          .replace(/<span[^>]*data-xsl-tag="pmark"[^>]*>([\s\S]*?)<\/span>/g, "$1")
          .replace(/<[^>]+>/g, "")
          .replace(/&lt;/g, "〈").replace(/&gt;/g, "〉").replace(/&amp;/g, "&")
          .trim();
        out.push({ vol: Number(m[1]), pcl, seq: seqOf(pcl), text, juan, sutra });
      }
      return;
    }
    for (const raw of body.split(/\r?\n/)) {
      const mt = /^(\d{4}[a-g]\d{2})\t(.*)$/.exec(raw);
      if (mt) out.push({ vol: 0, pcl: mt[1], seq: seqOf(mt[1]), text: mt[2], juan, sutra });
    }
  };
  emit(chunks[0] ?? "", 0);
  for (let i = 1; i < chunks.length; i += 2) emit(chunks[i + 1] ?? "", Number(chunks[i]));
  return out;
}

/** 卷界來源：最新的 k-txt/juaninfo.tsv（^j 標記只是當初的猜測，僅在 juaninfo 查無此經時才退回使用） */
const juanRef = new Map<string, [number, string, number][]>();
for (const line of readFileSync(join("k-txt", "juaninfo.tsv"), "utf-8").split(/\r?\n/)) {
  const c = line.split("\t");
  if (c.length < 6 || !/^\d/.test(c[0])) continue;
  if (!juanRef.has(c[0])) juanRef.set(c[0], []);
  juanRef.get(c[0])!.push([Number(c[3]), c[4], Number(c[1])]);
}
for (const v of juanRef.values()) v.sort((a, b) => seqOf(a[1]) - seqOf(b[1]));

const juaninfoRows: string[] = [];
const started = Date.now();

/** 每冊的輸出緩衝 */
const volLines = new Map<number, string[]>();
let nSutra = 0, nLine = 0, nFill = 0;

function processSutra(sutra: string, files: string[]) {
  const lines: Line[] = [];
  for (const f of files) {
    const txt = readFileSync(join(RAW, f), "utf-8").replace(/<TRANS>[\s\S]*?<\/TRANS>/g, "");
    lines.push(...parseHtml(txt, sutra));
  }
  if (!lines.length) return;
  // 同一 pcl 只留一筆：補抓檔（fill-）優先，因為它的卷號是實際抓取時確認過的
  const byPcl = new Map<string, Line>();
  for (const l of lines) {
    const key = `${l.vol}/${l.pcl}`;
    const prev = byPcl.get(key);
    if (!prev) { byPcl.set(key, l); continue; }
    // 主檔的卷號若大於補抓檔，以補抓檔為準
    if (l.juan && (!prev.juan || l.juan < prev.juan)) byPcl.set(key, l);
  }
  const all = [...byPcl.values()].sort((a, b) => a.vol - b.vol || a.seq - b.seq);

  // 卷界：以 k-txt/juaninfo.tsv 為準；查無此經時才用 ^j 標記推
  let starts: [number, string, number][] = (juanRef.get(sutra) ?? []).slice();
  if (!starts.length) {
    const mark = new Map<number, string>();
    for (const l of all) {
      if (!l.juan) continue;
      const cur = mark.get(l.juan);
      if (!cur || l.seq < seqOf(cur)) mark.set(l.juan, l.pcl);
    }
    starts = [...mark.entries()].sort((a, b) => seqOf(a[1]) - seqOf(b[1])).map(([n, p]) => [n, p, 0] as [number, string, number]);
  }
  const assign = (l: Line): number => {
    let j = 0;
    for (const [n, p, v] of starts) { if (v && v !== l.vol) continue; if (seqOf(p) <= l.seq) j = n; }
    return j;
  };
  let cur: { juan: number; lines: Line[] } | null = null;
  const flush = () => {
    if (!cur || !cur.lines.length) return;
    const first = cur.lines[0], last = cur.lines[cur.lines.length - 1];
    const name = first.text.slice(0, 40);
    const volLinesArr = volLines.get(first.vol) ?? [];
    volLines.set(first.vol, volLinesArr);
    volLinesArr.push(`^j${cur.juan}`);
    for (const l of cur.lines) volLinesArr.push(`${l.pcl}\t${l.text}`);
    juaninfoRows.push([sutra, String(first.vol).padStart(2, "0"), name, cur.juan, first.pcl, last.pcl, cur.lines.length].join("\t"));
  };
  for (const l of all) {
    const j = assign(l);
    if (!cur || cur.juan !== j) { flush(); cur = { juan: j, lines: [] }; }
    cur.lines.push(l);
  }
  flush();
  nSutra++; nLine += all.length;
}

// ---------------------------------------------------------------- 主流程

const files = readdirSync(RAW).filter(f => f.endsWith(".html"));
const bases = new Map<string, string[]>();
for (const f of files) {
  const id = f.replace(/\.html$/, "");
  const base = id.replace(/^fill-/, "").replace(/-$/, "").replace(/[a-z]$/, "");
  if (!bases.has(base)) bases.set(base, []);
  bases.get(base)!.push(f);
}
for (const [base, fs] of [...bases].sort()) {
  if (ONLY && base !== ONLY.replace(/[a-z]$/, "")) continue;
  if (fs.some(f => f.startsWith("fill-"))) nFill++;
  processSutra(base, fs.sort());
  if (nSutra % 100 === 0) process.stdout.write(`\r處理 ${nSutra} 部…`);
}

mkdirSync(OUT, { recursive: true });
for (const [vol, lines] of volLines) {
  writeFileSync(join(OUT, `K${String(vol).padStart(2, "0")}.tsv`), lines.join("\n") + "\n");
}
writeFileSync(join(OUT, "juaninfo.tsv"),
  ["經號\t冊號\t經名\t卷號\t起點\t終點\t總行數", ...juaninfoRows].join("\n") + "\n");

console.log(`\n【完成】${nSutra} 部經、${volLines.size} 冊、${nLine.toLocaleString()} 行，` +
  `${juaninfoRows.length} 卷；其中 ${nFill} 部有補抓檔；耗時 ${((Date.now() - started) / 1000).toFixed(0)}s`);
console.log(`       輸出 → ${OUT}/K??.tsv、${OUT}/juaninfo.tsv`);
