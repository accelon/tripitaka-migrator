// gen-spa.ts — 產生可雙擊執行的單檔 SPA（public/tripitaka-migrator.html）
//
// ・把 posmap.pos（zstd）的完整 payload 取出，改包成 gzip 容器
//   → 瀏覽器用原生 DecompressionStream('gzip') 就能解，不需任何外部程式庫
// ・整個資產以 base64 內嵌，單一 HTML 檔，file:// 直接雙擊可用
// ・四個範例經另外內嵌前幾行經文，按了就看得到對照
// ・其他經：位置照樣轉得出來，但本頁沒有經文 → 顯示「無庫存經文」
//
// 用法：bun gen-spa.ts

import { readPosAsset, POS_MAGIC, POS_FORMAT_VERSION, CODEC, crc32 } from "../core/posasset";
import { openPosSource, listTsutras, listJuans } from "../core/posdb";
import { openDb, buildGoryeoIndex, buildTaishoIndex, hanOnly } from "../core/juanindex";
import { pclOfSeq } from "../core/posfmt";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";

const COL = "abcdefg";
const SAMPLES = [
  { t: "0235", name: "金剛般若波羅蜜經", note: "姚秦 鳩摩羅什譯 · 一卷" },
  { t: "0099", name: "雜阿含經", note: "劉宋 求那跋陀羅譯 · 五十卷" },
  { t: "0366", name: "佛說阿彌陀經", note: "姚秦 鳩摩羅什譯 · 一卷" },
];
const NLINES = 3;
const t0 = Date.now();
mkdirSync("public", { recursive: true });

// ---------------------------------------------------------------- A. 資產轉 gzip
const src = new Uint8Array(await Bun.file("gopos/asset/posmap.pos").arrayBuffer());
const asset = readPosAsset(src);
const payload = asset.blobRegion;                       // 解壓後的完整 payload（含索引）
const gz = Bun.gzipSync(payload);
const out = new Uint8Array(36 + gz.length);
const dv = new DataView(out.buffer);
for (let i = 0; i < 8; i++) out[i] = POS_MAGIC.charCodeAt(i);
dv.setUint16(8, POS_FORMAT_VERSION, true);
dv.setUint8(10, CODEC.gzip);
dv.setUint32(12, payload.length, true);
dv.setUint32(20, gz.length, true);
dv.setUint32(28, crc32(payload), true);
dv.setUint32(32, 0, true);
out.set(gz, 36);
const b64 = Buffer.from(out).toString("base64");
console.log(`資產：payload ${(payload.length / 1048576).toFixed(2)} MB → gzip ${(gz.length / 1048576).toFixed(2)} MB → base64 ${(b64.length / 1048576).toFixed(2)} MB`);

// ---------------------------------------------------------------- B. 四個範例的經文
const posdb = openPosSource("posmap.db");
const kdb = openDb("K.db"), tdb = openDb("T.db");
buildGoryeoIndex(kdb, () => {}); buildTaishoIndex(tdb);
const qT = tdb.query("SELECT text FROM lines WHERE vol=? AND seq=? LIMIT 1");
const qK = kdb.query("SELECT text FROM lines WHERE vol=? AND seq=? LIMIT 1");
// 經名表（結果卡要顯示；去除卷次，過長的由 CSS 裁切）
const cleanName = (s: string) => String(s || "")
  .replace(/\^[a-z]+\d*/g, "")
  .replace(/\s+/g, "")
  // 去掉「(第1卷-第200卷)」這類註記：那是從卷第 1 卷錄下來的，跨冊時會變成錯的
  .replace(/[（(]第?[\d一二三四五六七八九十百千〇○零]+卷?[-–—~～至]第?[\d一二三四五六七八九十百千〇○零]+卷?[）)]/g, "")
  .replace(/卷[之第]?[一二三四五六七八九十百千〇〇零上下中]+$/, "").trim();
const tNames: Record<string, string> = {};
for (const r of tdb.query("SELECT sutra, name FROM juan WHERE juan = 1").all() as any[]) tNames[r.sutra] = cleanName(r.name);
const kNames: Record<string, string> = {};
for (const r of kdb.query("SELECT sutra, name FROM juan WHERE juan = 1").all() as any[]) kNames[r.sutra] = cleanName(r.name);

const lineText = (q: any, vol: number, seq: number) => hanOnly((q.get(vol, seq) as any)?.text ?? "");
const pclOf = (seq: number) => { const p = pclOfSeq(seq); return String(p.page).padStart(4, "0") + COL[p.col] + String(p.line).padStart(2, "0"); };

const samples: any[] = [];
for (const s of SAMPLES) {
  const rec = posdb.source.align(s.t, 1);
  if (!rec) { console.log(`  ${s.name}：查無對照卷`); continue; }
  const liAt = (g: any, off: number) => { let lo = 0, hi = g.nLines - 1, a = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (g.lineStart[m] <= off) { a = m; lo = m + 1; } else hi = m - 1; } return a; };
  const build = (s0: number) => {
    const ps: any[] = [];
    let blanks = 0;
    for (let li = s0; li < rec.t.nLines && ps.length < NLINES; li++) {
      if (rec.t.lineStart[li] >= rec.tBody[1]) break;
      const tSeq = rec.t.lineSeq[li];
      const xx = Math.max(rec.tBody[0], Math.min(rec.tBody[1], rec.t.lineStart[li]));
      const [y] = mapFwdJS(rec.runs, xx);
      const yy = Math.max(rec.kBody[0], Math.min(rec.kBody[1], y));
      const kli = liAt(rec.k, yy);
      const kSeq = rec.k.lineSeq[kli];
      const tTxt = lineText(qT, rec.t.vol, tSeq);
      const kTxt = lineText(qK, rec.k.vol, kSeq);
      if (!tTxt || !kTxt) { blanks++; continue; }   // 兩邊都要有字才列入
      ps.push({ t: tTxt, k: kTxt, tPcl: pclOf(tSeq), kPcl: pclOf(kSeq), kOff: yy - rec.k.lineStart[kli] });
    }
    return { ps, blanks };
  };
  // 挑「沒有空行、且字符偏置最明顯」的視窗
  const score = (r: any) => r.blanks > 0 ? -1 : r.ps.filter((p: any) => p.kOff > 0).length * 1000 + r.ps.reduce((a: number, p: any) => a + Math.min(p.kOff, 40), 0);
  const li0 = liAt(rec.t, rec.tBody[0]);
  let best: any = null, bestScore = -Infinity;
  for (let s0 = li0; s0 + NLINES <= rec.t.nLines; s0++) {
    const r = build(s0);
    if (r.ps.length < NLINES) break;
    const sc = score(r);
    if (sc > bestScore) { best = r; bestScore = sc; }
    if (bestScore >= NLINES * 1000) break;
  }
  if (!best) best = build(li0);
  const pairs: any[] = best.ps;  const mid = pairs[Math.floor(pairs.length / 2)];
  samples.push({
    tsutra: s.t, name: s.name, note: s.note, ksutra: rec.ksutra, kjuan: rec.kjuan,
    tVol: rec.t.vol, kVol: rec.k.vol, tjuan: rec.tjuan,
    demo: `T${String(rec.t.vol).padStart(2, "0")}p${mid.tPcl}00`, pairs,
  });
  console.log(`  ${s.name}：T${s.t} ⇄ K${rec.ksutra}　示範位址 ${samples[samples.length - 1].demo}　${pairs.length} 行`);
}
posdb.close(); kdb.close(); tdb.close();

function mapFwdJS(runs: Int32Array, x: number): [number, boolean] {
  const n = runs.length / 3; if (!n) return [0, false];
  let lo = 0, hi = n - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (runs[m * 3] <= x) { ans = m; lo = m + 1; } else hi = m - 1; }
  if (ans < 0) return [runs[1], false];
  const t0v = runs[ans * 3], k0v = runs[ans * 3 + 1], len = runs[ans * 3 + 2];
  return x < t0v + len ? [k0v + (x - t0v), true] : [k0v + len, false];
}

// ---------------------------------------------------------------- C. 輸出
function emit() {
const d = new Date();
const p2 = (x: number) => String(x).padStart(2, "0");
/** 版本號＝打包時間 */
const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
const fileStamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
const counts = `${asset.index.length.toLocaleString()} 卷 / ${new Set(asset.index.map(i => i.tsutra)).size.toLocaleString()} 部經`;
const html = HTML.replace("__DATA__", () => b64)
  .replace("/*__SAMPLES_JSON__*/null", () => JSON.stringify(samples))
  .replace("__COUNTS__", () => counts)
  .replace("/*__NAMES_JSON__*/null", () => JSON.stringify({ t: tNames, k: kNames }))
  .replace(/__BUILD__/g, () => stamp);
writeFileSync("public/tripitaka-migrator.html", html);

// 把「版本＝打包時間」與另存連結寫進簡報首頁
const idxPath = "public/index.html";
if (existsSync(idxPath)) {
  let idx = readFileSync(idxPath, "utf-8");
  const verLine = '<p class="ver">版本 <b>' + stamp +
    '</b>　·　<a href="tripitaka-migrator.html" download="tripitaka-migrator-' + fileStamp +
    '.html" title="另存到本機；也可在此連結上按右鍵 → 另存連結">⬇ 另存檔案</a><span>單一 HTML 檔，' +
    (html.length / 1048576).toFixed(1) + ' MB，存下來就能離線使用</span></p>';
  if (/<p class="ver">[\s\S]*?<\/p>/.test(idx)) {
    idx = idx.replace(/<p class="ver">[\s\S]*?<\/p>/, () => verLine);
    writeFileSync(idxPath, idx);
  }
}
console.log(`\n輸出 public/tripitaka-migrator.html　${(html.length / 1048576).toFixed(2)} MB　版本 ${stamp}　耗時 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`       另存檔名 tripitaka-migrator-${fileStamp}.html，已同步寫入 public/index.html 首頁`);
}

const HTML = await Bun.file(import.meta.dir + "/spa-template.html").text();

emit();
