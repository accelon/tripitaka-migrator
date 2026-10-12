// onlydiag.ts — T01–T55 的「SAT/其他」無對應行，診斷其鄰居關係
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const COLS = "abcdefg";
const ord = (p: string) => Number(p.slice(0, 4)) * 1000 + COLS.indexOf(p[4]) * 100 + Number(p.slice(5));
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ffff}]/gu;
const han = (s: string) => (s.match(HAN) ?? []).join("");

// 待診斷的列
interface Row { vol: number; sutra: string; pcl: string; o: number; text: string }
const rows: Row[] = [];
for (const line of readFileSync("tables/sat-cbeta-posonly.tsv", "utf-8").split(/\r?\n/)) {
  const c = line.split("\t");
  if (c.length < 6 || c[0] !== "SAT" || c[4] !== "其他") continue;
  const vol = Number(c[1]);
  if (vol >= 56 || !vol) continue;
  rows.push({ vol, sutra: c[2], pcl: c[3], o: ord(c[3]), text: c[5] });
}
console.log(`待診斷：SAT/其他 且 T01–T55 共 ${rows.length.toLocaleString()} 行`);

// 重建 CBETA 位置集合（只讀用到的冊）
const need = new Set(rows.map(r => r.vol));
const cb = new Map<string, Map<number, string>>();
for (const dir of readdirSync("cbeta")) {
  if (!/^T\d\d$/.test(dir)) continue;
  if (!need.has(Number(dir.slice(1)))) continue;
  for (const f of readdirSync(join("cbeta", dir))) {
    const m = /^T\d\dn(\d+)([a-z]?)_(\d{3})\.xml$/.exec(f);
    if (!m) continue;
    const key = m[1] + (m[2] ? m[2].toUpperCase() : "");
    let txt = readFileSync(join("cbeta", dir, f), "utf-8");
    const a = txt.indexOf("<text>"), b = txt.indexOf("</text>");
    if (a >= 0 && b > a) txt = txt.slice(a, b);
    const parts = txt.split(/<lb\b[^>]*\bn="(\d{4}[a-g]\d{2})"[^>]*\/>/);
    if (!cb.has(key)) cb.set(key, new Map());
    const g = cb.get(key)!;
    for (let i = 1; i < parts.length; i += 2) {
      const t = han((parts[i + 1] ?? "")
        .replace(/<note\b[^>]*\/>/g, "").replace(/<note\b[^>]*>[\s\S]*?<\/note>/g, "")
        .replace(/<rdg\b[^>]*\/>/g, "").replace(/<rdg\b[^>]*>[\s\S]*?<\/rdg>/g, "")
        .replace(/<[^>]+>/g, ""));
      if (t) g.set(ord(parts[i]), t);
    }
  }
  process.stdout.write(`\r讀取 ${dir}…`);
}

let prev = 0, next = 0, neither = 0, both = 0, similar = 0;
const simEx: string[] = [], neiEx: string[] = [], farEx: string[] = [];
for (const r of rows) {
  const g = cb.get(r.sutra);
  if (!g) { neither++; continue; }
  const p = g.get(r.o - 1), n = g.get(r.o + 1);
  if (p && n) both++; else if (p || n) { if (p) prev++; else next++; }
  else { neither++; if (farEx.length < 8) farEx.push(`T${r.vol} ${r.sutra} ${r.pcl}  ${r.text.slice(0, 30)}`); continue; }
  const nb = p ?? n!;
  const m = Math.max(r.text.length, nb.length);
  let hit = 0;
  for (let i = 0; i < Math.min(r.text.length, nb.length); i++) if (r.text[i] === nb[i]) hit++;
  const ratio = m ? hit / m : 0;
  if (ratio >= 0.5) { similar++; if (simEx.length < 8) simEx.push(`T${r.vol} ${r.sutra} ${r.pcl} SAT「${r.text.slice(0, 22)}」 vs CB${p ? "-1" : "+1"}「${nb.slice(0, 22)}」`); }
  else if (neiEx.length < 8) neiEx.push(`T${r.vol} ${r.sutra} ${r.pcl} SAT「${r.text.slice(0, 22)}」 / CB「${nb.slice(0, 22)}」`);
}
console.log(`\n\n【鄰居診斷】`);
console.log(`  前一格或後一格 CBETA 有內容：${(prev + next + both).toLocaleString()}（${((prev + next + both) / rows.length * 100).toFixed(1)}%）`);
console.log(`    ・只有前一格 ${prev.toLocaleString()}、只有後一格 ${next.toLocaleString()}、兩邊都有 ${both.toLocaleString()}`);
console.log(`  前後都沒有 CBETA 內容：${neither.toLocaleString()}（${(neither / rows.length * 100).toFixed(1)}%）`);
console.log(`  鄰居內容相似（≥0.5）：${similar.toLocaleString()}`);
console.log(`\n  鄰居相似例：`); simEx.forEach(s => console.log("   " + s));
console.log(`\n  鄰居不相似例：`); neiEx.forEach(s => console.log("   " + s));
console.log(`\n  前後皆空的例（真‧只在 SAT 出現）：`); farEx.forEach(s => console.log("   " + s));
