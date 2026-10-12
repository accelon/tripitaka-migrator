// checkjuan.ts — 任務 1：檢查高麗藏每一部經與對應大正藏經的卷數是否一致
//
// 用法：
//   bun checkjuan.ts                 # 印出卷數不一致的經典，並寫出 checkjuan.tsv
//   bun checkjuan.ts --all           # 連同卷數一致的經典一併印出
//
// 對照來源：goryeo2taisho.json（高麗經號 -> 大正經號）
// 卷數來源：K.db / T.db 的 juan 表（K.db 的分冊錯位不影響卷數，只影響取文位置）

import { writeFileSync } from "fs";
import { openDb, buildGoryeoIndex, buildTaishoIndex, loadMapping, normSutra } from "../core/juanindex";

const KDB = process.env.KDB ?? "K.db";
const TDB = process.env.TDB ?? "T.db";
const SHOW_ALL = process.argv.includes("--all");

const t0 = Date.now();
const kdb = openDb(KDB);
const tdb = openDb(TDB);

const kIdx = buildGoryeoIndex(kdb, msg => console.log(`[索引] ${msg}`));
const tIdx = buildTaishoIndex(tdb);
const mapping = loadMapping();

console.log(`[索引] T 卷索引：${tIdx.size} 部經`);
console.log(`[對照] goryeo2taisho.json：${mapping.size} 筆\n`);

type Status = "一致" | "不一" | "局部對應" | "合刊" | "無對照" | "大正缺此經";

interface Row {
  k: string; kName: string; kJuan: number; t: string; tName: string; tJuan: number;
  status: Status; note: string;
}

/** 取該經的經名（以第一卷為準） */
const kNameOf = (s: string) => (kIdx.get(s)?.juan[0]?.name ?? "").trim();
const tNameOf = (s: string) => {
  const e = tIdx.get(normSutra(s).toUpperCase());
  return (e?.juan[0]?.name ?? "").trim();
};

const rows: Row[] = [];
for (const [k, ki] of [...kIdx].sort((a, b) => a[0].localeCompare(b[0]))) {
  const m = mapping.get(k);
  const kName = kNameOf(k);
  if (!m || m.kind === "none") {
    rows.push({ k, kName, kJuan: ki.juanCount, t: "", tName: "", tJuan: 0, status: "無對照", note: "對照表無此經號" });
    continue;
  }
  if (m.kind === "multi") {
    let n = 0; const miss: string[] = [];
    for (const p of m.parts!) {
      const e = tIdx.get(normSutra(p).toUpperCase());
      if (e) n += e.juanCount; else miss.push(p);
    }
    const note = n === ki.juanCount
      ? m.note!
      : `${m.note!}；高麗以 ${ki.juanCount} 卷合刊，大正分為 ${m.parts!.length} 部共 ${n} 卷，卷數口徑不同${miss.length ? `（缺 ${miss.join(",")}）` : ""}`;
    rows.push({
      k, kName, kJuan: ki.juanCount, t: m.parts!.join("+"),
      tName: m.parts!.map(tNameOf).join(" / "), tJuan: n, status: "合刊", note,
    });
    continue;
  }
  const tKey = normSutra(m.target!).toUpperCase();
  const ti = tIdx.get(tKey);
  if (!ti) {
    rows.push({ k, kName, kJuan: ki.juanCount, t: m.raw!, tName: "", tJuan: 0, status: "大正缺此經", note: "T.db 無此經號" });
    continue;
  }
  if (m.kind === "partial") {
    rows.push({
      k, kName, kJuan: ki.juanCount, t: m.raw!, tName: tNameOf(m.target!),
      tJuan: ti.juanCount, status: "局部對應", note: `${m.note!}（大正 ${m.target} 全經 ${ti.juanCount} 卷）`,
    });
    continue;
  }
  rows.push({
    k, kName, kJuan: ki.juanCount, t: ti.sutra, tName: tNameOf(ti.sutra), tJuan: ti.juanCount,
    status: ti.juanCount === ki.juanCount ? "一致" : "不一",
    note: ti.juanCount === ki.juanCount ? "" : `差 ${ki.juanCount - ti.juanCount > 0 ? "+" : ""}${ki.juanCount - ti.juanCount} 卷（高麗 − 大正）`,
  });
}

// ---------------------------------------------------------------- 輸出

const mismatched = rows.filter(r => r.status === "不一");
const partial = rows.filter(r => r.status === "局部對應");
const unpaired = rows.filter(r => r.status === "無對照" || r.status === "大正缺此經");
const multiOk = rows.filter(r => r.status === "合刊");
const same = rows.filter(r => r.status === "一致");

const pad = (s: string, n: number) => {
  let w = 0; for (const ch of s) w += /[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch) ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - w));
};

function printRows(title: string, list: Row[]) {
  if (list.length === 0) return;
  console.log(`\n===== ${title}（${list.length} 部）=====`);
  console.log(`${pad("高麗", 8)}${pad("卷", 6)}${pad("大正", 14)}${pad("卷", 6)}${pad("經名", 34)}備註`);
  for (const r of list) {
    const tShow = r.t.length > 13 ? `${r.t.slice(0, 11)}…` : r.t;
    console.log(`${pad(r.k, 8)}${pad(String(r.kJuan), 6)}${pad(tShow || "-", 14)}${pad(String(r.tJuan), 6)}${pad(r.kName.slice(0, 16), 34)}${r.note}`);
  }
}

console.log("===== 卷數統計 =====");
console.log(`  高麗藏經數            ${rows.length}`);
console.log(`  卷數一致              ${same.length}`);
console.log(`  卷數不一致            ${mismatched.length}`);
console.log(`  合刊（卷數相符）      ${multiOk.length}`);
console.log(`  局部對應（無法比卷數）${partial.length}`);
console.log(`  無對照／大正缺此經    ${unpaired.length}`);

printRows("卷數不一致", mismatched);
if (partial.length) printRows("局部對應（高麗一卷對應大正大經的局部，卷數無法比較）", partial);
if (unpaired.length) printRows("無對照 / 大正缺此經", unpaired);
if (multiOk.length) printRows("合刊且卷數相符", multiOk);
if (SHOW_ALL) printRows("卷數一致", same);

// 完整明細
const HEAD = ["高麗經號", "高麗經名", "高麗卷數", "大正經號", "大正經名", "大正卷數", "狀態", "備註"];
const tsv = [HEAD.join("\t")];
for (const r of rows) {
  tsv.push([r.k, r.kName.replace(/\t/g, " "), r.kJuan, r.t, r.tName.replace(/\t/g, " "), r.tJuan, r.status, r.note].join("\t"));
}
writeFileSync("tables/checkjuan.tsv", tsv.join("\n") + "\n", "utf-8");
console.log(`\n完整明細已寫入 checkjuan.tsv（${rows.length} 列）。耗時 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

kdb.close();
tdb.close();
