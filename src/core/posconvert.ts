// posconvert.ts — convert_taisho_goryeo 的命令列介面
//
// 用法：
//   bun posconvert.ts T01p0002c0405                    # 查一個位置
//   bun posconvert.ts T01p0002c0405 T01p0001a0500 …    # 查多個
//   bun posconvert.ts --show T01p0002c0405             # 另附兩藏該處的原文與上下文
//   bun posconvert.ts --json posdata/0001.json T01p…   # 走網頁那條路（只讀 JSON，完全不碰 .db）
//   bun posconvert.ts --verify [--sutra 0001]          # 逐字驗證 posmap.db
//
// 選項：--db posmap.db  --kdb K.db  --tdb T.db

import { openPosSource, PosDb } from "./posdb";
import {
  AlignRec, AlignSource, convertTaishoGoryeo, convertGoryeoTaisho, mapTOffset, mapKOffset,
  jsonSource, SutraJson, findLine, mergeRunTriples, decodeAlign,
} from "./posmap";
import { readPosAsset } from "./posasset";
import { Address, parseAddress, parsePcl, seqOf, pclOfSeq, formatAddress } from "./posfmt";
import { openDb, readJuan, buildGoryeoIndex, buildTaishoIndex, normSutra, hanOnly } from "./juanindex";
import { myersDiff, bodyBoundsOf, buildAlignment } from "./similarity";
import { readFileSync, existsSync, readdirSync, writeFileSync } from "fs";
import { resolve } from "path";

const REF_TSV = process.env.REF ?? "comparejuan.tsv";

const argv = process.argv.slice(2);
const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const has = (n: string) => argv.includes(n);
const VALUE_FLAGS = ["--db", "--kdb", "--tdb", "--json", "--sutra"];
const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(argv[i - 1] ?? ""));

const DB_PATH = flag("--db") ?? "posmap.db";
const KDB = flag("--kdb") ?? "K.db";
const TDB = flag("--tdb") ?? "T.db";
const JSON_PATH = flag("--json");

// ---------------------------------------------------------------- 資料來源

let source: AlignSource;
let posdb: PosDb | null = null;
let jsonDoc: SutraJson | null = null;

if (JSON_PATH) {
  jsonDoc = JSON.parse(readFileSync(JSON_PATH, "utf-8")) as SutraJson;
  source = jsonSource(jsonDoc);
  console.log(`[來源] ${JSON_PATH}：T${jsonDoc.tsutra} ⇄ K${jsonDoc.ksutra}，` +
    `${Object.keys(jsonDoc.juan).length} 卷、${(readFileSync(JSON_PATH).length / 1024).toFixed(0)} KB（未使用任何 .db）`);
} else {
  posdb = openPosSource(DB_PATH);
  source = posdb.source;
}

/** 由位址找出所屬的對齊卷（CLI：查 posmap.db；JSON：掃該檔各卷的行表） */
function recOf(a: Address): AlignRec | null {
  if (posdb) {
    const hit = posdb.findByTsutra(a.vol, seqOf(a));
    return hit ? source.align(hit.tsutra, hit.tjuan) : null;
  }
  for (const k of Object.keys(jsonDoc!.juan)) {
    const rec = jsonSource(jsonDoc!).align(jsonDoc!.tsutra, Number(k));
    if (rec && rec.t.vol === a.vol && findLine(rec.t, seqOf(a))[1]) return rec;
  }
  return null;
}

const charOffT = (rec: AlignRec, tPcl: string, off: number) => {
  const p = parsePcl(tPcl)!;
  const [li] = findLine(rec.t, seqOf(p));
  return rec.t.lineStart[li] + off;
};
const charOffK = (rec: AlignRec, kPcl: string, off: number) => {
  const p = parsePcl(kPcl)!;
  const [li] = findLine(rec.k, seqOf(p));
  return rec.k.lineStart[li] + off;
};

// ---------------------------------------------------------------- 查一個位址

function printOne(addrStr: string, show: boolean) {
  const a = parseAddress(addrStr);
  if (!a) { console.log(`✗ ${addrStr}：位址無法解析\n`); return; }
  if (a.side !== "T") { console.log(`✗ ${addrStr}：本介面輸入大正藏位址（T 開頭）\n`); return; }
  const rec = recOf(a);
  if (!rec) { console.log(`✗ ${addrStr}：第 ${a.vol} 冊此頁在對照資料中找不到\n`); return; }
  const res = convertTaishoGoryeo(rec, a);
  if (!res.ok) { console.log(`✗ ${addrStr}：${res.note}\n`); return; }

  const tx = charOffT(rec, res.tPcl, res.tOff);
  const ky = charOffK(rec, res.kPcl, res.kOff);
  const m = mapTOffset(rec, tx);
  console.log(`輸入        ${addrStr}`);
  console.log(`高麗藏      ${res.koryo}`);
  console.log(`修正後大正  ${res.adjustedTaisho}`);
  console.log(`經卷        T${res.tsutra} 卷 ${res.tjuan}  ⇄  K${res.ksutra} 卷 ${res.kjuan}`);
  console.log(`對照        ${res.tPcl} 第 ${res.tOff} 字  →  ${res.kPcl} 第 ${res.kOff} 字` +
    `（全卷位移 ${m.src} → ${ky}${m.exact ? "，精確對應" : "，落在單邊插文"}）`);
  if (res.adjust !== "none") console.log(`調整        ${res.adjust}`);
  if (res.note) console.log(`備註        ${res.note}`);

  if (show) {
    const kdb = openDb(KDB), tdb = openDb(TDB);
    const kIdx = buildGoryeoIndex(kdb, () => {}), tIdx = buildTaishoIndex(tdb);
    const kRec = kIdx.get(normSutra(rec.ksutra))!.juan.find(j => j.juan === rec.kjuan)!;
    const tRec = tIdx.get(normSutra(rec.tsutra))!.juan.find(j => j.juan === rec.tjuan)!;
    const kt = readJuan(kdb, kRec), tt = readJuan(tdb, tRec);
    const w = (s: string, i: number) => `${s.slice(Math.max(0, i - 10), i)}【${s[i] ?? "∅"}】${s.slice(i + 1, i + 11)}`;
    console.log(`大正原文    …${w(tt.hanzi, tx)}…`);
    console.log(`高麗原文    …${w(kt.hanzi, ky)}…`);
    kdb.close(); tdb.close();
  }
  console.log("");
}

// ---------------------------------------------------------------- 全面驗證

function verify() {
  const only = flag("--sutra");
  const kdb = openDb(KDB), tdb = openDb(TDB);
  const kIdx = buildGoryeoIndex(kdb, () => {}), tIdx = buildTaishoIndex(tdb);
  const rows = posdb!.db.query("SELECT tsutra, tjuan FROM align ORDER BY tsutra, tjuan")
    .all() as { tsutra: string; tjuan: number }[];

  // 獨立對照組：comparejuan.tsv（由另一支程式、另一套程式路徑算出來的 新增/刪除/替代）
  const ref = new Map<string, { ins: number; del: number; sub: number }>();
  if (existsSync(REF_TSV)) {
    for (const line of readFileSync(REF_TSV, "utf-8").split(/\r?\n/)) {
      const c = line.split("\t");
      if (c.length < 11 || c[0] === "高麗經號") continue;
      ref.set(`${normSutra(c[1]).toUpperCase()}/${c[2]}`, { ins: Number(c[8]), del: Number(c[9]), sub: Number(c[10]) });
    }
  }

  let nJuan = 0, nPos = 0, matched = 0, subst = 0, insT = 0, delK = 0;
  let nonMono = 0, outBody = 0, rtBad = 0, geomBad = 0, addrBad = 0, refBad = 0, refJuan = 0;
  const substPairs = new Map<string, number>();
  const problems: string[] = [];
  const note = (s: string) => { if (problems.length < 40) problems.push(s); };

  for (const row of rows) {
    if (only && normSutra(only).toUpperCase() !== row.tsutra) continue;
    const rec = source.align(row.tsutra, row.tjuan)!;
    const kRec = kIdx.get(normSutra(rec.ksutra))!.juan.find(j => j.juan === rec.kjuan)!;
    const tRec = tIdx.get(normSutra(rec.tsutra))!.juan.find(j => j.juan === rec.tjuan)!;
    const kt = readJuan(kdb, kRec), tt = readJuan(tdb, tRec);
    const tag = `T${row.tsutra}/${row.tjuan}`;

    // 1) 行表幾何是否與資料庫一致
    if (tt.hanzi.length !== rec.t.han || kt.hanzi.length !== rec.k.han) {
      geomBad++; note(`${tag} 漢字數不符：DB ${tt.hanzi.length}/${kt.hanzi.length}，posmap ${rec.t.han}/${rec.k.han}`);
      continue;
    }
    const geomOk = (g: typeof rec.t, lines: { pcl: string; text: string }[]) => {
      let acc = 0;
      for (let i = 0; i < lines.length; i++) {
        if (g.lineSeq[i] !== seqOf(parsePcl(lines[i].pcl)!) || g.lineStart[i] !== acc) return false;
        acc += hanOnly(lines[i].text ?? "").length;
      }
      return g.nLines === lines.length && g.lineStart[lines.length] === acc;
    };
    if (!geomOk(rec.t, tt.lines) || !geomOk(rec.k, kt.lines)) { geomBad++; note(`${tag} 行表不符`); continue; }

    nJuan++;
    // 2) 逐字掃過「可對照範圍」，檢查單調、邊界、來回一致
    let prevY = -1;
    for (let x = rec.tBody[0]; x < rec.tBody[1]; x++) {
      const m = mapTOffset(rec, x);
      const y = m.dst;
      nPos++;
      if (y < prevY) { nonMono++; note(`${tag} 位移 ${x} 對照不單調`); }
      prevY = y;
      if (y < rec.kBody[0] || y > rec.kBody[1]) outBody++;
      if (m.exact) {
        const tc = tt.hanzi[x], kc = kt.hanzi[y];
        if (tc === kc) matched++;
        else { subst++; substPairs.set(`${tc}→${kc}`, (substPairs.get(`${tc}→${kc}`) ?? 0) + 1); }
        if (mapKOffset(rec, y).dst !== x) { rtBad++; note(`${tag} 位移 ${x}→${y}→${mapKOffset(rec, y).dst} 來回不一致`); }
      } else insT++;
    }
    for (let i = 0; i < rec.kBody[1] - rec.kBody[0]; i++) void i;

    // 3) 與 comparejuan.tsv 對帳：只在「diff 求出的正文」上比
    //    (a) 結構對帳：把存下來的對應段裁到 diff 正文，必須與現場重算的完全一樣
    //    (b) 數字對帳：新增／刪除／替代 三欄必須與 comparejuan.tsv 一字不差
    const refRow = ref.get(`${normSutra(rec.tsutra).toUpperCase()}/${rec.tjuan}`);
    if (refRow) {
      refJuan++;
      const segs = myersDiff(kt.hanzi, tt.hanzi);
      const bb = bodyBoundsOf(segs, kt.hanzi.length, tt.hanzi.length);
      const clip = (t0: number, k0: number, len: number) => {
        let t = t0, k = k0;
        if (t < bb.headB) { const d = bb.headB - t; t += d; k += d; len -= d; }
        if (k < bb.headA) { const d = bb.headA - k; t += d; k += d; len -= d; }
        if (t + len > bb.tailB) len = bb.tailB - t;
        if (k + len > bb.tailA) len = bb.tailA - k;
        return len;
      };
      const exp = buildAlignment(segs);
      let expSub = 0;
      const expTriples: number[] = [];
      for (const r of exp) {
        const len = clip(r.t, r.k, r.len);
        if (len <= 0) continue;
        expTriples.push(r.t < bb.headB ? bb.headB : r.t, r.k < bb.headA ? bb.headA : r.k, len);
        if (r.paired) expSub += len;
      }
      const gotTriples: number[] = [];
      for (let i = 0; i < rec.runs.length; i += 3) {
        const len = clip(rec.runs[i], rec.runs[i + 1], rec.runs[i + 2]);
        if (len <= 0) continue;
        const t = rec.runs[i], k = rec.runs[i + 1];
        gotTriples.push(t < bb.headB ? bb.headB : t, k < bb.headA ? bb.headA : k, len);
      }
      // 存下來的是「合併首尾相接的段」後的形式；把現場重算的也合併再比，兩者必須完全相同。
      const expMerged = mergeRunTriples(Int32Array.from(expTriples));
      const gotMerged = mergeRunTriples(Int32Array.from(gotTriples));
      if (expMerged.join(",") !== gotMerged.join(",")) {
        refBad++;
        note(`${tag} 對應段與現場重算不符（存 ${gotMerged.length / 3} 段、算 ${expMerged.length / 3} 段）`);
      } else if (expSub !== refRow.sub) {
        refBad++;
        note(`${tag} 替代字數不符：${expSub} vs comparejuan ${refRow.sub}`);
      }
      // (b) 逐位置數字
      let mi = 0, md = 0, covered = 0;
      const cov = new Uint8Array(Math.max(0, bb.tailA - bb.headA));
      for (let x = bb.headB; x < bb.tailB; x++) {
        const m = mapTOffset(rec, x);
        if (m.exact && m.dst >= bb.headA && m.dst < bb.tailA) { cov[m.dst - bb.headA] = 1; covered++; }
        else mi++;
      }
      for (let i = 0; i < cov.length; i++) if (!cov[i]) md++;
      if (mi !== refRow.ins || md !== refRow.del || covered !== bb.tailA - bb.headA - refRow.del) {
        refBad++;
        note(`${tag} 與 comparejuan.tsv 不符：新增 ${mi}/${refRow.ins}、刪除 ${md}/${refRow.del}、對到 ${covered}`);
      }
    }

    // 4) 位址層抽樣：逐行行首各查一次，結果必須與位移層一致
    for (let li = 0; li < rec.t.nLines; li++) {
      const pcl = pclOfSeq(rec.t.lineSeq[li]);
      const res = convertTaishoGoryeo(rec, { side: "T", vol: rec.t.vol, page: pcl.page, col: pcl.col, line: pcl.line, off: 0 });
      if (!res.ok) { addrBad++; note(`${tag} ${pcl} 位址層失敗：${res.note}`); continue; }
      const want = mapTOffset(rec, rec.t.lineStart[li]).dst;
      const got = charOffK(rec, res.kPcl, res.kOff);
      if (got !== want) { addrBad++; note(`${tag} ${pcl} 位址層 ${got} ≠ 位移層 ${want}`); }
    }
    // 5) 反向轉換抽樣
    for (let i = 0; i < rec.k.nLines; i += 7) {
      const pcl = pclOfSeq(rec.k.lineSeq[i]);
      const res = convertGoryeoTaisho(rec, { side: "K", vol: rec.k.vol, page: pcl.page, col: pcl.col, line: pcl.line, off: 0 });
      if (!res.ok) { addrBad++; note(`${tag} 反向 ${pcl} 失敗：${res.note}`); }
    }
  }
  kdb.close(); tdb.close();

  console.log(`\n=== 逐字驗證報告（${only ? "T" + normSutra(only) : "posmap.db 全部"}）===`);
  console.log(`卷數              ${nJuan}`);
  console.log(`可對照位置數      ${nPos}`);
  console.log(`  相同字          ${matched}`);
  console.log(`  替代字          ${subst}`);
  console.log(`  T 有 K 無       ${insT}`);
  console.log(`對齊不單調        ${nonMono}`);
  console.log(`K 落在正文外      ${outBody}`);
  console.log(`來回轉換不一致    ${rtBad}`);
  console.log(`行表／字數不符    ${geomBad}`);
  console.log(`位址層不符        ${addrBad}`);
  console.log(`與 comparejuan 不符 ${refBad} / 比對 ${refJuan} 卷`);
  console.log(`替代字 Top 15     ${[...substPairs].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, v]) => `${k}(${v})`).join(" ")}`);
  if (problems.length) { console.log("問題樣本："); for (const p of problems.slice(0, 30)) console.log("  " + p); }
  const pass = nonMono === 0 && outBody === 0 && rtBad === 0 && geomBad === 0 && addrBad === 0 && refBad === 0;
  console.log(pass ? "\n✓ 全部通過" : "\n✗ 有問題");
  process.exit(pass ? 0 : 1);
}

// ---------------------------------------------------------------- 網頁路徑驗證
//
// 用「瀏覽器實際會載入的那個 bundle + 那份 JSON」跑一遍，和 SQLite 路徑逐位置對帳。

async function verifyWeb() {
  const dir = flag("--json-dir") ?? "posdata";
  const web = await import("./webdist/posweb.js");
  const files = readdirSync(dir).filter(f => f.endsWith(".json")).sort();
  if (files.length === 0) { console.log(`✗ ${dir} 底下沒有 JSON`); process.exit(1); }
  const urls = files.map(f => "file:///" + resolve(dir, f).replace(/\\/g, "/"));
  const fetchStub = async (u: string) => {
    const p = decodeURIComponent(u.replace(/^file:\/{2,3}/, ""));
    const txt = readFileSync(p, "utf-8");
    return { ok: true, status: 200, json: async () => JSON.parse(txt), text: async () => txt };
  };
  const src = await web.loadSource(urls, fetchStub);

  const rows = posdb!.db.query("SELECT tsutra, tjuan FROM align ORDER BY tsutra, tjuan")
    .all() as { tsutra: string; tjuan: number }[];
  let n = 0, badRec = 0, badConv = 0, nConv = 0;
  const problems: string[] = [];
  for (const row of rows) {
    const a = source.align(row.tsutra, row.tjuan)!;
    const b = src.align(row.tsutra, row.tjuan);
    n++;
    if (!b) { badRec++; problems.push(`T${row.tsutra}/${row.tjuan} JSON 缺這一卷`); continue; }
    const same = a.t.han === b.t.han && a.k.han === b.k.han &&
      a.t.vol === b.t.vol && a.k.vol === b.k.vol &&
      a.tBody[0] === b.tBody[0] && a.tBody[1] === b.tBody[1] &&
      a.kBody[0] === b.kBody[0] && a.kBody[1] === b.kBody[1] &&
      a.coarse === b.coarse && a.runs.length === b.runs.length &&
      a.t.lineSeq.every((v, i) => v === b.t.lineSeq[i]) &&
      a.k.lineSeq.every((v, i) => v === b.k.lineSeq[i]) &&
      a.runs.every((v, i) => v === b.runs[i]);
    if (!same) { badRec++; problems.push(`T${row.tsutra}/${row.tjuan} JSON 與 DB 的對齊資料不同`); continue; }

    for (let li = 0; li < a.t.nLines; li += 3) {
      const pcl = pclOfSeq(a.t.lineSeq[li]);
      for (const off of [0, 1, 7, 20]) {
        const addr = { side: "T" as const, vol: a.t.vol, page: pcl.page, col: pcl.col, line: pcl.line, off };
        const ra = convertTaishoGoryeo(a, addr);
        const rb = web.convertTaishoGoryeo(b, addr);
        nConv++;
        if (ra.koryo !== rb.koryo || ra.adjustedTaisho !== rb.adjustedTaisho || ra.note !== rb.note) {
          badConv++;
          if (problems.length < 20) problems.push(`T${row.tsutra}/${row.tjuan} ${formatAddress(addr)}：DB ${ra.koryo} vs 網頁 ${rb.koryo}`);
        }
      }
    }
  }
  console.log(`\n=== 網頁路徑驗證（webdist/posweb.js + ${dir}）===`);
  console.log(`載入 JSON        ${files.length} 檔${files.length <= 12 ? "（" + files.join(" ") + "）" : `（${files.slice(0, 6).join(" ")} … ${files[files.length - 1]}）`}`);
  console.log(`對帳卷數          ${n}`);
  console.log(`對齊資料不符      ${badRec}`);
  console.log(`逐位置對帳        ${nConv} 次，不符 ${badConv}`);
  if (problems.length) { for (const p of problems.slice(0, 20)) console.log("  " + p); }
  const pass = badRec === 0 && badConv === 0;
  console.log(pass ? "\n✓ 網頁路徑與資料庫路徑完全一致" : "\n✗ 不一致");
  process.exit(pass ? 0 : 1);
}

// ---------------------------------------------------------------- binary asset 驗證
//
// 把 posmap.pos 解回來，逐欄位、逐位置與 SQLite 路徑對帳。

function verifyAsset() {
  const path = flag("--verify-asset") ?? "gopos/asset/posmap.pos";
  const raw = readFileSync(path);
  const asset = readPosAsset(new Uint8Array(raw));
  const idx = new Map<string, number>();
  asset.index.forEach((r, i) => idx.set(`${r.tsutra}/${r.tjuan}`, i));
  console.log(`asset      ${path}：codec ${asset.codec}、payload ${(asset.rawLen / 1048576).toFixed(2)} MB、` +
    `檔案 ${(raw.length / 1048576).toFixed(2)} MB、${asset.index.length} 卷、CRC 通過`);

  let n = 0, badRec = 0, badConv = 0, nConv = 0;
  const problems: string[] = [];
  for (const r of asset.index) {
    const i = idx.get(`${r.tsutra}/${r.tjuan}`)!;
    const a = source.align(r.tsutra, r.tjuan);
    n++;
    if (!a) { badRec++; problems.push(`T${r.tsutra}/${r.tjuan} DB 缺這一卷`); continue; }
    const b = { tsutra: r.tsutra, tjuan: r.tjuan, ksutra: r.ksutra, kjuan: r.kjuan, ...decodeAlign(asset.blob(i)) };
    const same = a.t.han === b.t.han && a.k.han === b.k.han && a.t.vol === b.t.vol && a.k.vol === b.k.vol &&
      a.tBody[0] === b.tBody[0] && a.tBody[1] === b.tBody[1] &&
      a.kBody[0] === b.kBody[0] && a.kBody[1] === b.kBody[1] && a.coarse === b.coarse &&
      a.t.lineSeq.every((v, k) => v === b.t.lineSeq[k]) &&
      a.k.lineSeq.every((v, k) => v === b.k.lineSeq[k]) &&
      a.t.lineStart.every((v, k) => v === b.t.lineStart[k]) &&
      a.k.lineStart.every((v, k) => v === b.k.lineStart[k]) &&
      a.runs.length === b.runs.length && a.runs.every((v, k) => v === b.runs[k]);
    if (!same) { badRec++; problems.push(`T${r.tsutra}/${r.tjuan} asset 與 DB 的對齊資料不同`); continue; }

    for (let li = 0; li < a.t.nLines; li++) {
      const pcl = pclOfSeq(a.t.lineSeq[li]);
      for (const off of [0, 1, 3, 5, 9]) {
        const addr = { side: "T" as const, vol: a.t.vol, page: pcl.page, col: pcl.col, line: pcl.line, off };
        const ra = convertTaishoGoryeo(a, addr), rb = convertTaishoGoryeo(b, addr);
        nConv++;
        if (ra.koryo !== rb.koryo || ra.adjustedTaisho !== rb.adjustedTaisho || ra.note !== rb.note) {
          badConv++;
          if (problems.length < 20) problems.push(`T${r.tsutra}/${r.tjuan} ${formatAddress(addr)}：DB ${ra.koryo} vs asset ${rb.koryo}`);
        }
      }
    }
  }
  console.log(`對帳卷數    ${n}`);
  console.log(`對齊資料不符 ${badRec}`);
  console.log(`逐位置對帳  ${nConv} 次，不符 ${badConv}`);
  for (const p of problems.slice(0, 20)) console.log("  " + p);
  const pass = badRec === 0 && badConv === 0;
  console.log(pass ? "\n✓ binary asset 與資料庫路徑完全一致" : "\n✗ 不一致");
  process.exit(pass ? 0 : 1);
}

// ---------------------------------------------------------------- 產生跨實作測資
//
// 把「每一卷每一行的行首與數個偏置」的換算結果寫成 TSV，交給 Go 版重算並逐欄比對。
// 欄位：方向 輸入 高麗藏 修正後大正 頁欄行T 偏置T 頁欄行K 偏置K 調整 精確 備註

function emitCases(out: string) {
  const MISS = ["", "", "", "", "", "", "", "", ""];
  const lines: string[] = ["dir\tinput\tkoryo\tadjustedTaisho\ttPcl\ttOff\tkPcl\tkOff\tadjust\texact\tnote"];
  const add = (dir: string, res: ReturnType<typeof convertTaishoGoryeo>) => {
    if (!res.ok) { lines.push([dir, res.input, ...MISS.slice(0, 8), res.note].join("\t")); return; }
    lines.push([
      dir, res.input, res.koryo, res.adjustedTaisho, res.tPcl, res.tOff, res.kPcl, res.kOff,
      res.adjust, res.exact ? "1" : "0", res.note,
    ].join("\t"));
  };
  /** 與 CLI 完全相同的入口：先由「冊 + 頁欄行」定位到卷，找不到就記一筆 miss */
  const emit = (dir: "t2k" | "k2t", a: Address) => {
    const rec = dir === "t2k" ? recOf(a) : recOfK(a);
    if (!rec) {
      lines.push([dir + "-miss", formatAddress(a), ...MISS].join("\t"));
      return;
    }
    add(dir, dir === "t2k" ? convertTaishoGoryeo(rec, a) : convertGoryeoTaisho(rec, a));
  };
  const rows = posdb!.db.query("SELECT tsutra, tjuan FROM align ORDER BY tsutra, tjuan")
    .all() as { tsutra: string; tjuan: number }[];
  const stride = Number(flag("--sample") ?? 1) || 1;
  let n = 0;
  for (let ri = 0; ri < rows.length; ri++) {
    if (ri % stride !== 0) continue;
    const row = rows[ri];
    const rec = source.align(row.tsutra, row.tjuan)!;
    for (let li = 0; li < rec.t.nLines; li++) {
      const p = pclOfSeq(rec.t.lineSeq[li]);
      for (const off of [0, 1, 5, 37, 99]) {
        emit("t2k", { side: "T", vol: rec.t.vol, page: p.page, col: p.col, line: p.line, off });
        n++;
      }
    }
    for (let li = 0; li < rec.k.nLines; li++) {
      const p = pclOfSeq(rec.k.lineSeq[li]);
      for (const off of [0, 1, 5, 37, 99]) {
        emit("k2t", { side: "K", vol: rec.k.vol, page: p.page, col: p.col, line: p.line, off });
        n++;
      }
    }
    // 不存在的頁碼與不存在的冊號：兩邊都必須「找不到」
    // （用 9999 這種全庫都不可能出現的值，否則期望值會隨 asset 涵蓋範圍而變）
    emit("t2k", { side: "T", vol: rec.t.vol, page: 9999, col: 0, line: 1, off: 0 });
    emit("t2k", { side: "T", vol: 9999, page: 1, col: 0, line: 1, off: 0 });
    emit("k2t", { side: "K", vol: rec.k.vol, page: 9999, col: 0, line: 1, off: 0 });
    emit("k2t", { side: "K", vol: 9999, page: 1, col: 0, line: 1, off: 0 });
    n += 4;
  }
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`[測資] ${out}：${n} 筆（${Math.ceil(rows.length / stride)} / ${rows.length} 卷，取樣間隔 ${stride}）`);
}

/** 由高麗藏位址找出所屬的對齊卷（同樣先查索引，再換成大正藏那一側的記錄） */
function recOfK(a: Address): AlignRec | null {
  if (!posdb) return null;
  const hit = posdb.findByKsutra(a.vol, seqOf(a));
  if (!hit) return null;
  const r = posdb.db.query("SELECT tsutra, tjuan FROM align WHERE ksutra = ? AND kjuan = ?")
    .get(hit.ksutra, hit.kjuan) as { tsutra: string; tjuan: number } | null;
  return r ? source.align(r.tsutra, r.tjuan) : null;
}

// ---------------------------------------------------------------- 主流程

if (has("--emit-cases")) {
  if (!posdb) { console.log("--emit-cases 需要 posmap.db"); process.exit(1); }
  emitCases(flag("--emit-cases")!);
} else if (has("--verify-asset") || argv.includes("--verify-asset")) {
  if (!posdb) { console.log("--verify-asset 需要 posmap.db 作為對照"); process.exit(1); }
  verifyAsset();
} else if (has("--verify-web")) {
  if (!posdb) { console.log("--verify-web 需要 posmap.db 作為對照"); process.exit(1); }
  await verifyWeb();
} else if (has("--verify")) {
  if (!posdb) { console.log("--verify 需要 posmap.db"); process.exit(1); }
  verify();
} else if (positional.length === 0) {
  console.log(`用法：
  bun posconvert.ts T01p0002c0405 [更多位址…]        查位置
  bun posconvert.ts --show T01p0002c0405             另印兩藏原文
  bun posconvert.ts --json posdata/0001.json T01p…   只讀 JSON（網頁路徑）
  bun posconvert.ts --verify [--sutra 0001]          逐字驗證
選項：--db posmap.db  --kdb K.db  --tdb T.db`);
  process.exit(1);
} else {
  for (const a of positional) printOne(a, has("--show"));
}
posdb?.close();
