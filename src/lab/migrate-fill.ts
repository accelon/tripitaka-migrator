// migrate-fill.ts — 把舊的 fill-*.html（純 pcl\ttext）轉成正常 HTML 片段
// 並直接追加到該經自己的 goryeo-raw-html/<經號>.html，然後刪掉 fill 檔。
// 卷號→冊號 由 k-txt/juaninfo.tsv 查得（一卷只屬一冊）。
import { readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync, existsSync, copyFileSync } from "fs";
import { join } from "path";

const RAW = "goryeo-raw-html";
const volOf = new Map<string, number>();
for (const line of readFileSync("k-txt/juaninfo.tsv", "utf-8").split(/\r?\n/)) {
  const c = line.split("\t");
  if (c.length < 6 || !/^\d/.test(c[0])) continue;
  volOf.set(`${c[0]}/${c[3]}`, Number(c[1]));
}

const fills = readdirSync(RAW).filter(f => f.startsWith("fill-") && f.endsWith(".html"));
let nSutra = 0, nLine = 0;
for (const f of fills) {
  const sutra = f.replace(/^fill-/, "").replace(/\.html$/, "");
  const target = join(RAW, `${sutra}.html`);
  const out: string[] = [`<!-- 補抓 ${new Date().toISOString().slice(0, 10)} -->`];
  let juan = 0, unknown = 0;
  for (const raw of readFileSync(join(RAW, f), "utf-8").split(/\r?\n/)) {
    const mj = /^\^j(\d+)$/.exec(raw.trim());
    if (mj) { juan = Number(mj[1]); continue; }
    const mt = /^(\d{4})([a-g])(\d{2})\t(.*)$/.exec(raw);
    if (!mt) continue;
    const vol = volOf.get(`${sutra}/${juan}`);
    if (!vol) { unknown++; continue; }
    const id = `${String(vol).padStart(3, "0")}_${mt[1]}_${mt[2]}_${mt[3]}L`;
    out.push(`<span data-xsl-lineid="${id}" data-xsl-tag="line">${id}</span>${mt[4]}`);
    nLine++;
  }
  if (unknown) console.log(`  K${sutra}：${unknown} 行查不到冊號，略過`);
  if (out.length <= 1) continue;
  if (existsSync(target) && !existsSync(target + ".bak")) copyFileSync(target, target + ".bak");
  appendFileSync(target, "\n" + out.join("\n") + "\n", "utf8");
  unlinkSync(join(RAW, f));
  nSutra++;
  console.log(`  K${sutra}：追加 ${out.length - 1} 行 → ${target}（原檔備份 .bak）`);
}
console.log(`【完成】${nSutra} 部經、${nLine.toLocaleString()} 行併入；fill 檔已刪除`);
