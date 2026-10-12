// _cbchars.ts — 全藏：SAT 與 CBETA 的用字差異（整卷漢字 bag 比對）
//   bun _cbchars.ts [冊...]
import { readFileSync, readdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ffff}]/gu;
const seq = (p: string) => Number(p.slice(0, 4)) * 1000 + (p.charCodeAt(4) - 97) * 100 + Number(p.slice(5));
const LB_RE = /<lb n="(\d{4}[a-g]\d{2})"[^>]*\/>/g;

function bag(s: string, m: Map<string, number>) { for (const c of s.match(CJK) ?? []) m.set(c, (m.get(c) ?? 0) + 1); }

// SAT juaninfo
const ji = new Map<string, { juan: number; start: string; end: string }[]>();
for (const line of readFileSync("t-txt/juaninfo.tsv", "utf-8").split(/\r?\n/)) {
  const c = line.split("\t");
  if (c.length < 6 || !/^\d/.test(c[0])) continue;
  const k = c[0].toUpperCase();
  if (!ji.has(k)) ji.set(k, []);
  ji.get(k)!.push({ juan: Number(c[3]), start: c[4], end: c[5] });
}

const satCache = new Map<string, Map<string, string>>();
const readSat = (vol: string) => {
  let m = satCache.get(vol);
  if (m) return m;
  m = new Map();
  const p = join("t-txt", `${vol}.tsv`);
  if (existsSync(p)) for (const line of readFileSync(p, "utf-8").split(/\r?\n/)) {
    const i = line.indexOf("\t"); if (i > 0) m!.set(line.slice(0, i), line.slice(i + 1));
  }
  satCache.set(vol, m);
  return m;
};

const satOnly = new Map<string, number>(), cbOnly = new Map<string, number>();
let nJuan = 0, nSatHan = 0, nCbHan = 0;

const vols = process.argv.slice(2).length ? process.argv.slice(2)
  : readdirSync("cbeta").filter(d => /^T\d\d$/.test(d)).sort();

for (const v of vols) {
  const dir = join("cbeta", v);
  let files: string[]; try { files = readdirSync(dir).filter(f => f.endsWith(".xml")); } catch { continue; }
  const sat = readSat(v);
  for (const f of files) {
    const m = /^T(\d\d)n(\d+)([a-z]?)_(\d{3})\.xml$/.exec(f);
    if (!m) continue;
    const no = m[2] + (m[3] ? m[3].toUpperCase() : ""), juan = Number(m[4]);
    const rec = ji.get(no)?.find(x => x.juan === juan);
    if (!rec) continue;
    let xml = readFileSync(join(dir, f), "utf-8");
    const a = xml.indexOf("<text>"), b = xml.indexOf("</text>");
    xml = a >= 0 && b > a ? xml.slice(a, b) : xml;
    // CBETA：去校勘記與異文
    const cbTxt = xml.replace(/<note\b[^>]*\/>/g, "").replace(/<note\b[^>]*>[\s\S]*?<\/note>/g, "")
      .replace(/<rdg\b[^>]*\/>/g, "").replace(/<rdg\b[^>]*>[\s\S]*?<\/rdg>/g, "")
      .replace(/<cb:mulu\b[^>]*\/>/g, "").replace(/<cb:mulu\b[^>]*>[\s\S]*?<\/cb:mulu>/g, "")
      .replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "");
    const cbBag = new Map<string, number>(); bag(cbTxt, cbBag);
    // SAT：juaninfo 範圍
    const satBag = new Map<string, number>();
    const lo = seq(rec.start), hi = seq(rec.end);
    for (const [k, t] of sat) { const s = seq(k); if (s >= lo && s <= hi) bag(t, satBag); }
    for (const [ch, n] of satBag) { const d = n - (cbBag.get(ch) ?? 0); if (d > 0) satOnly.set(ch, (satOnly.get(ch) ?? 0) + d); }
    for (const [ch, n] of cbBag) { const d = n - (satBag.get(ch) ?? 0); if (d > 0) cbOnly.set(ch, (cbOnly.get(ch) ?? 0) + d); }
    for (const n of satBag.values()) nSatHan += n;
    for (const n of cbBag.values()) nCbHan += n;
    nJuan++;
  }
}

const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
const rows = ["SAT字\tSAT_U+\tCBETA字\tCBETA_U+\t差異量\t方向"];
// 把兩邊配對：以「同一個字在另一邊被換成什麼」為單位，這裡先各自列出
for (const [c, n] of top(satOnly, 200)) rows.push([c, `U+${c.codePointAt(0)!.toString(16).toUpperCase()}`, "", "", n, "SAT 有、CBETA 少"].join("\t"));
for (const [c, n] of top(cbOnly, 200)) rows.push(["", "", c, `U+${c.codePointAt(0)!.toString(16).toUpperCase()}`, n, "CBETA 有、SAT 少"].join("\t"));
writeFileSync("tables/cbeta-sat-chars.tsv", rows.join("\n") + "\n");
if (!existsSync("tables/cbeta-sat-chars.tsv")) console.log("寫檔失敗");
console.log(`【範圍】${nJuan} 卷；SAT 漢字 ${nSatHan.toLocaleString()}、CBETA 漢字 ${nCbHan.toLocaleString()}（差 ${(nSatHan - nCbHan).toLocaleString()}）→ cbeta-sat-chars.tsv`);
console.log(`\nSAT 有、CBETA 少掉的字（前 30）：`);
for (const [c, n] of top(satOnly, 30)) console.log(`  ${c}  U+${c.codePointAt(0)!.toString(16).toUpperCase()}  ${n.toLocaleString()}`);
console.log(`\nCBETA 有、SAT 少掉的字（前 30）：`);
for (const [c, n] of top(cbOnly, 30)) console.log(`  ${c}  U+${c.codePointAt(0)!.toString(16).toUpperCase()}  ${n.toLocaleString()}`);
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
console.log(`\n差異總量：SAT 獨有 ${sum(satOnly).toLocaleString()} 字、CBETA 獨有 ${sum(cbOnly).toLocaleString()} 字`);
