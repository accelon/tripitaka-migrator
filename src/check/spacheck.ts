// _spacheck.ts — 把 public/tripitaka-migrator.html 裡的瀏覽器程式載進 Bun 跑，與參考實作逐筆比對
import { openPosSource, listTsutras, listJuans } from "../core/posdb";
import { convertTaishoGoryeo, lineIndexAt } from "../core/posmap";
import { pclOfSeq, type Address } from "../core/posfmt";

const html = await Bun.file("public/tripitaka-migrator.html").text();
const s0 = html.lastIndexOf("<script>") + 8, s1 = html.lastIndexOf("</script>");
let script = html.slice(s0, s1);
script = script.replace(/\(async \(\) => \{[\s\S]*$/, "");          // 去掉 UI 啟動段
const stubEl: any = { innerHTML: "", textContent: "", value: "", title: "", addEventListener() {}, closest: () => null, setAttribute() {}, getAttribute() { return null; } };
const root2: any = { _t: "light", setAttribute(k: string, v: string) { if (k === "data-theme") this._t = v; }, getAttribute() { return this._t; } };
const doc: any = { documentElement: root2, getElementById: () => stubEl };
const api = new Function("document", script + "\nreturn { load, convertT, IDX: () => IDX };")(doc) as any;

console.log("載入瀏覽器端資產…");
const t0 = Date.now();
await api.load();
console.log(`  解壓完成，${api.IDX().length.toLocaleString()} 卷，耗時 ${Date.now() - t0} ms`);

// 參考實作：與 postest 相同方式抽樣
const posdb = openPosSource("posmap.db");
const cases: { addr: string; ref: string }[] = [];
const COL = "abcdefg";
for (const ts of listTsutras(posdb.db)) {
  const juans = listJuans(posdb.db, ts);
  if (!juans.length) continue;
  const j = juans[0];
  const rec = posdb.source.align(ts, j.tjuan);
  if (!rec) continue;
  const len = rec.tBody[1] - rec.tBody[0];
  if (len < 40) continue;
  const x = Math.round(rec.tBody[0] + 0.45 * len);
  const li = lineIndexAt(rec.t, x);
  const pc = pclOfSeq(rec.t.lineSeq[li]);
  const off = x - rec.t.lineStart[li];
  const addr = { side: "T", vol: rec.t.vol, page: pc.page, col: pc.col, line: pc.line, off } as Address;
  const r = convertTaishoGoryeo(rec, addr);
  if (!r.ok) continue;
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  const tAddr = `T${p(rec.t.vol, 2)}p${p(pc.page, 4)}${COL[pc.col]}${p(pc.line, 2)}${off < 100 ? p(off, 2) : "." + off}`;
  cases.push({ addr: tAddr, ref: r.koryo });
  if (cases.length >= 400) break;
}
posdb.close();
console.log(`比對 ${cases.length} 筆（每部經取一點）`);

let ok = 0;
const bad: string[] = [];
for (const c of cases) {
  const got = api.convertT(c.addr);
  const g = got.ok ? got.kAddr : "(失敗)";
  if (g === c.ref) ok++;
  else if (bad.length < 8) bad.push(`${c.addr}  瀏覽器 ${g}  參考 ${c.ref}`);
}
console.log(`\n一致 ${ok} / ${cases.length}（${(ok / cases.length * 100).toFixed(2)}%）`);
if (bad.length) { console.log("不一致樣本："); bad.forEach(b => console.log("  " + b)); }
