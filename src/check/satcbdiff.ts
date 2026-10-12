// satcbdiff.ts — SAT 2018（raw）與 CBETA 大正藏 的行位置對照
//
// 原則：
//   ・SAT 的權威來源是 sat-raw-html，t-txt 只是程序產物
//   ・空行不算位置（沒有人會引用空行），只比「有內容的行」
//
// 兩邊都是「刻本每一行一個編號」：
//   SAT  raw 每行前綴    T{經號}_{冊}.{頁}{欄}{行}:
//   CBETA 每個 <lb n="頁欄行">
// 有內容的行位置理論上應完全相同；不同之處就是 CBETA 動過的位置。
//
// 用法：bun satcbdiff.ts [--vol 20] [--show 30]

import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const ONLY = flag("--vol");
const SHOW = Number(flag("--show")) || 30;
const COLS = "abcdefg";
const ord = (pcl: string) => Number(pcl.slice(0, 4)) * 1000 + COLS.indexOf(pcl[4]) * 100 + Number(pcl.slice(5));
const fmt = (o: number) => { const r = o % 1000; return String((o - r) / 1000).padStart(4, "0") + COLS[Math.floor(r / 100)] + String(r % 100).padStart(2, "0"); };
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ffff}]/gu;
const han = (s: string) => (s.match(HAN) ?? []).join("");

/** 同一行的判定：容忍異體字與標點差異 */
function matchScore(a: string, b: string): number {
  const n = Math.max(a.length, b.length);
  if (!n) return 0;
  if (Math.abs(a.length - b.length) > Math.max(3, n * 0.35)) return 0;
  let hit = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) hit++;
  return hit / n;
}

// ---------------------------------------------------------------- SAT raw
const SAT_LINE = /^T(\d+[A-Z]?)_\.(\d\d)\.(\d{4})([a-g])(\d{2}): ?(.*)$/;
const NOTE = /<button class="ftntf" title="[^"]*">\d+<\/button>/g;
const satClean = (s: string) => han(s.replace(NOTE, "").replace(/<[^>]+>/g, ""));

function readSatVol(dir: string) {
  const out = new Map<string, Map<number, string>>();
  for (const f of readdirSync(join("sat-raw-html", dir))) {
    if (!f.endsWith(".html")) continue;
    let txt: string; try { txt = readFileSync(join("sat-raw-html", dir, f), "utf-8"); } catch { continue; }
    for (const line of txt.split(/\r?\n/)) {
      const m = SAT_LINE.exec(line);
      if (!m) continue;
      const t = satClean(m[6]);
      if (!t) continue;                                  // 空行不計
      if (!out.has(m[1])) out.set(m[1], new Map());
      const g = out.get(m[1])!;
      const o = ord(m[3] + m[4] + m[5]);
      const prev = g.get(o);
      if (!prev || t.length > prev.length) g.set(o, t);
    }
  }
  return out;
}

// ---------------------------------------------------------------- CBETA
function readCbVol(dir: string) {
  const out = new Map<string, Map<number, string>>();
  for (const f of readdirSync(join("cbeta", dir))) {
    const m = /^T\d\dn(\d+)([a-z]?)_(\d{3})\.xml$/.exec(f);
    if (!m) continue;
    const key = m[1] + (m[2] ? m[2].toUpperCase() : "");
    let txt: string; try { txt = readFileSync(join("cbeta", dir, f), "utf-8"); } catch { continue; }
    const a = txt.indexOf("<text>"), b = txt.indexOf("</text>");
    if (a >= 0 && b > a) txt = txt.slice(a, b);
    const parts = txt.split(/<lb\b[^>]*\bn="(\d{4}[a-g]\d{2})"[^>]*\/>/);   // 屬性順序兩種都有（T56+ 是 ed 在前）
    if (!out.has(key)) out.set(key, new Map());
    const g = out.get(key)!;
    for (let i = 1; i < parts.length; i += 2) {
      const body = parts[i + 1] ?? "";
      const t = han(body
        .replace(/<note\b[^>]*\/>/g, "").replace(/<note\b[^>]*>[\s\S]*?<\/note>/g, "")
        .replace(/<rdg\b[^>]*\/>/g, "").replace(/<rdg\b[^>]*>[\s\S]*?<\/rdg>/g, "")
        .replace(/<cb:mulu\b[^>]*\/>/g, "").replace(/<cb:mulu\b[^>]*>[\s\S]*?<\/cb:mulu>/g, "")
        .replace(/<[^>]+>/g, ""));
      if (!t) continue;                                  // 空行不計
      const o = ord(parts[i]);
      const prev = g.get(o);
      if (!prev || t.length > prev.length) g.set(o, t);
    }
  }
  return out;
}

/** 依行文特徵分類（卷首題／品題／序跋／譯者行／其他） */
function kindOf(t: string): string {
  if (/卷[之第]?[一二三四五六七八九十百千〇○零上下中]+$/.test(t)) return "卷首題";
  if (/[一二三四五六七八九十百千]+卷$/.test(t)) return "卷首題";
  if (/(品|會)[第]?[一二三四五六七八九十百千之]+$/.test(t) || /品$/.test(t)) return "品題";
  if (/[序跋述譔撰製]$/.test(t)) return "序跋題";
  if (/譯$|三藏|奉\s*詔/.test(t)) return "譯者行";
  if (/二合|三合|引$|半$/.test(t)) return "咒語行";
  if (/[經論律疏記傳錄集儀軌陀羅尼呪偈讚]$/.test(t)) return "經名（無卷次）";
  return "其他";
}// ---------------------------------------------------------------- 比對
const rows: string[] = ["冊\t經號\tSAT位置\tCBETA位置\t位移\t類別\t內容"];
const rowsOnly: string[] = ["來源\t冊\t經號\t位置\t類別\t內容"];
const sum = { same: 0, diff: 0, moved: 0, satOnlyLeft: 0, cbOnlyLeft: 0 };
const volStat = new Map<string, number>();
const examples: string[] = [];

const dirs = readdirSync("sat-raw-html").filter(d => /^T\d\d$/.test(d) && (!ONLY || d === `T${ONLY.padStart(2, "0")}`)).sort();
const cbDirs = new Set(readdirSync("cbeta"));
for (const dir of dirs) {
  if (!cbDirs.has(dir)) continue;
  const sat = readSatVol(dir), cb = readCbVol(dir);
  const vol2 = dir.slice(1);
  for (const [key, sg] of sat) {
    const cg = cb.get(key);
    if (!cg) continue;
    const so = [...sg.keys()].sort((x, y) => x - y);
    const co = [...cg.keys()].sort((x, y) => x - y);
    const setC = new Set(co), setS = new Set(so);
    const aOnly = so.filter(x => !setC.has(x));
    const bOnly = co.filter(x => !setS.has(x));
    if (!aOnly.length && !bOnly.length) { sum.same++; continue; }
    sum.diff++;
    volStat.set(vol2, (volStat.get(vol2) ?? 0) + 1);
    const used = new Set<number>(); const usedX = new Set<number>();
    let matched = 0;
    for (const x of aOnly) {
      const tx = sg.get(x)!;
      let best = -1, score = 0.8;
      for (const y of bOnly) {
        if (used.has(y)) continue;
        const r = matchScore(tx, cg.get(y)!);
        if (r >= score) { score = r; best = y; }
      }
      if (best >= 0) {
        if (Math.abs(best - x) > 30) continue;   // 位移超過 30 行 → 誤配，丟棄
        used.add(best); usedX.add(x); matched++; sum.moved++;
        rows.push([vol2, key, fmt(x), fmt(best), best - x, kindOf(tx), tx.slice(0, 60)].join("\t"));
        if (examples.length < SHOW) examples.push(`  T${vol2} ${key}   SAT ${fmt(x)} → CBETA ${fmt(best)}  (${best - x > 0 ? "+" : ""}${best - x})   ${tx.slice(0, 20)}`);
      }
    }
    for (const x of aOnly) if (!usedX.has(x)) rowsOnly.push(["SAT", vol2, key, fmt(x), kindOf(sg.get(x)!)].concat(sg.get(x)!.slice(0, 40)).join("\t"));
    for (const y of bOnly) if (!used.has(y)) rowsOnly.push(["CBETA", vol2, key, fmt(y), kindOf(cg.get(y)!)].concat(cg.get(y)!.slice(0, 40)).join("\t"));
    sum.satOnlyLeft += aOnly.length - matched;
    sum.cbOnlyLeft += bOnly.length - matched;
  }
  process.stdout.write(`\r掃描 ${dir}…`);
}
writeFileSync("tables/sat-cbeta-posdiff.tsv", rows.join("\n") + "\n");
writeFileSync("tables/sat-cbeta-posonly.tsv", rowsOnly.join("\n") + "\n");

console.log(`\n\n【結果】（只比有內容的行，空行不計）`);
console.log(`  位置完全相同：${sum.same} 部；有差異：${sum.diff} 部`);
console.log(`  ・同一行被編到不同位置（真正的位移）：${sum.moved.toLocaleString()} 行`);
console.log(`  ・SAT 有、CBETA 找不到對應：${sum.satOnlyLeft.toLocaleString()} 行`);
console.log(`  ・CBETA 有、SAT 找不到對應：${sum.cbOnlyLeft.toLocaleString()} 行`);
console.log(`\n  位移集中的冊：` + [...volStat].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([v, n]) => `T${v}:${n}`).join(" "));
console.log(`\n  前 ${examples.length} 例：`);
for (const e of examples) console.log(e);
console.log(`\n→ sat-cbeta-posdiff.tsv`);
