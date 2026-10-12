// posselftest.ts — 位址格式、gpos 壓縮、varint 編碼的單元自測
//
//   bun posselftest.ts

import {
  parseAddress, formatAddress, packGpos, unpackGpos, seqOf, pclOfSeq, formatPcl, parsePcl,
  ByteWriter, decodeU32, bytesToB64, b64ToBytes,
} from "../core/posfmt";
import { encodeAlign, decodeAlign, AlignBody } from "../core/posmap";

let pass = 0, fail = 0;
const norm = (v: any) => (ArrayBuffer.isView(v) ? Array.from(v as any) : v);
const eq = (got: any, want: any, what: string) => {
  const g = JSON.stringify(norm(got)), w = JSON.stringify(norm(want));
  if (g === w) { pass++; return; }
  fail++; console.log(`✗ ${what}\n    得到 ${g}\n    預期 ${w}`);
};

// ---- 位址解析 ----
const P = (s: string) => parseAddress(s)!;
eq(P("T01p0002c0405"), { side: "T", vol: 1, page: 2, col: 2, line: 4, off: 5 }, "T01p0002c0405");
eq(P("K17p0815a0301"), { side: "K", vol: 17, page: 815, col: 0, line: 3, off: 1 }, "K17p0815a0301");
eq(P("T01p0002c04"), { side: "T", vol: 1, page: 2, col: 2, line: 4, off: 0 }, "偏置 0 可省略");
eq(P("t1p2c0405"), { side: "T", vol: 1, page: 2, col: 2, line: 4, off: 5 }, "小寫與不補零");
eq(P("T49p0024a17.118"), { side: "T", vol: 49, page: 24, col: 0, line: 17, off: 118 }, "長行用點號接三位偏置");
eq(P("T01p0002c405"), { side: "T", vol: 1, page: 2, col: 2, line: 40, off: 5 }, "行號固定取前兩位（故 c405 是行 40）");
eq(parseAddress("T01p0002c0405x"), null, "多餘字元要拒絕");
eq(parseAddress("X01p0002c0405"), null, "只認 T / K");
eq(parseAddress("T01p0002h0405"), null, "欄號只到 g");
eq(parseAddress("T01p0002"), null, "缺欄行要拒絕");

// ---- 位址格式化（可來回）----
for (const s of ["T01p0002c0405", "K17p0815a0301", "T49p0024a17.118", "K01p0001a0100"]) {
  eq(formatAddress(P(s)), s, `來回 ${s}`);
}
eq(formatAddress(P("T01p0002c0405"), { omitZeroOffset: true }), "T01p0002c0405", "偏置 5 不省略");
eq(formatAddress(P("K01p0001a0100"), { omitZeroOffset: true }), "K01p0001a01", "偏置 0 可省略");

// ---- gpos 壓縮 ----
const cases = [
  [1, 2, 2, 4, 5], [17, 815, 0, 3, 1], [49, 24, 0, 17, 118],
  [85, 9999, 6, 99, 999], [999, 1464, 4, 92, 0], [1, 1, 0, 1, 0],
];
for (const [vol, page, col, line, off] of cases) {
  const g = packGpos(vol, page, col, line, off);
  eq(unpackGpos(g), { vol, page, col, line, off }, `gpos ${vol}/${page}/${col}/${line}/${off}`);
  if (!Number.isSafeInteger(g)) { fail++; console.log(`✗ gpos ${g} 不是安全整數`); }
}
// 閱讀順序＝數值順序
const order = [
  [1, 1, 0, 1, 0], [1, 1, 0, 1, 5], [1, 1, 0, 2, 0], [1, 1, 1, 1, 0], [1, 2, 0, 1, 0], [2, 1, 0, 1, 0],
].map(a => packGpos(a[0], a[1], a[2], a[3], a[4]));
eq(order.every((v, i) => i === 0 || order[i - 1] < v), true, "gpos 順序＝閱讀順序");
eq(packGpos(999, 9999, 6, 99, 999) < Number.MAX_SAFE_INTEGER, true, "gpos 在安全整數內");

// ---- PCL / seq ----
eq(seqOf({ page: 2, col: 2, line: 4 }), 2204, "seq = page*1000 + col*100 + line");
eq(pclOfSeq(2204), { page: 2, col: 2, line: 4 }, "seq 反解");
eq(formatPcl(parsePcl("0815a03")!), "0815a03", "PCL 來回");

// ---- varint / base64 ----
const nums = [0, 1, 127, 128, 300, 16383, 16384, 1e6, 2 ** 31];
const w = new ByteWriter();
for (const n of nums) w.u32(n);
const bytes = w.bytes();
let pos = 0; const back: number[] = [];
for (let i = 0; i < nums.length; i++) { const r = decodeU32(bytes, pos); back.push(r.value); pos = r.pos; }
eq(back, nums, "varint 來回");
eq(pos, bytes.length, "varint 用盡緩衝");
eq(Array.from(b64ToBytes(bytesToB64(bytes))), Array.from(bytes), "base64 來回");

// ---- AlignBody 編碼 ----
const body: AlignBody = {
  t: { vol: 3, lineSeq: Int32Array.from([1001, 1002, 1003]), lineStart: Int32Array.from([0, 5, 7, 7]), nLines: 3, han: 7 },
  k: { vol: 8, lineSeq: Int32Array.from([2001, 2005]), lineStart: Int32Array.from([0, 4, 7]), nLines: 2, han: 7 },
  tBody: Int32Array.from([1, 6]), kBody: Int32Array.from([0, 5]),
  tPre: 1, tPost: 1, kPre: 0, kPost: 2,
  runs: Int32Array.from([1, 0, 3, 5, 4, 1]),
  coarse: true,
};
const dec = decodeAlign(encodeAlign(body));
eq(dec.t.lineSeq, Array.from(body.t.lineSeq), "編碼 t.lineSeq");
eq(dec.k.lineSeq, Array.from(body.k.lineSeq), "編碼 k.lineSeq");
eq(dec.t.lineStart, Array.from(body.t.lineStart), "編碼 t.lineStart");
eq(dec.k.lineStart, Array.from(body.k.lineStart), "編碼 k.lineStart");
eq(dec.runs, Array.from(body.runs), "編碼 runs");
eq([dec.tBody[0], dec.tBody[1], dec.kBody[0], dec.kBody[1]], [1, 6, 0, 5], "編碼正文範圍");
eq([dec.tPre, dec.tPost, dec.kPre, dec.kPost], [1, 1, 0, 2], "編碼序言附文");
eq(dec.coarse, true, "編碼 coarse");
eq([dec.t.vol, dec.k.vol, dec.t.han, dec.k.han, dec.t.nLines, dec.k.nLines], [3, 8, 7, 7, 3, 2], "編碼冊號與字數");

// ---- 對應段合併（mergeRunTriples）----
import { mapOffset, mapOffsetRev, mergeRunTriples } from "../core/posmap";

// 首尾相接且位移差相同的段會被併成一段
eq(mergeRunTriples(Int32Array.from([0, 0, 5, 5, 5, 3, 8, 8, 2])), [0, 0, 10], "相接的段合併成一段");
// 有插入（t 側留空隙）就不能併
eq(mergeRunTriples(Int32Array.from([0, 0, 5, 8, 5, 3])), [0, 0, 5, 8, 5, 3], "t 側有空隙不併");
// 有刪除（k 側留空隙）也不能併
eq(mergeRunTriples(Int32Array.from([0, 0, 5, 5, 8, 3])), [0, 0, 5, 5, 8, 3], "k 側有空隙不併");
eq(mergeRunTriples(Int32Array.from([])), [], "空輸入");
eq(mergeRunTriples(Int32Array.from([3, 7, 2])), [3, 7, 2], "單段不變");

// 合併必須完全等價：對整個範圍逐一比對 mapOffset / mapOffsetRev 的結果
{
  let seed = 12345;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  let mismatch = 0, checked = 0;
  for (let trial = 0; trial < 200; trial++) {
    const raw: number[] = [];
    let t = 0, k = 0;
    for (let i = 0, n = 1 + rnd(12); i < n; i++) {
      t += rnd(4); k += rnd(4);                       // 隨機空隙
      const len = 1 + rnd(8);
      raw.push(t, k, len);
      t += len; k += len;
    }
    const before = Int32Array.from(raw);
    const after = mergeRunTriples(before);
    for (let x = 0; x <= t + 4; x++) {
      const a = mapOffset(before, x), b = mapOffset(after, x);
      checked++;
      if (a[0] !== b[0] || a[1] !== b[1]) mismatch++;
    }
    for (let y = 0; y <= k + 4; y++) {
      const a = mapOffsetRev(before, y), b = mapOffsetRev(after, y);
      checked++;
      if (a[0] !== b[0] || a[1] !== b[1]) mismatch++;
    }
  }
  eq(mismatch, 0, `合併前後 ${checked} 次查詢結果完全相同`);
}

console.log(`\n通過 ${pass}、失敗 ${fail}`);
process.exit(fail ? 1 : 0);
