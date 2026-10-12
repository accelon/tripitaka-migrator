// posweb.ts — 網頁端入口：用 fetch 取得對照 JSON，組出 AlignSource
//
// 網頁用法（見 posdemo.html）：
//   import { loadSource, convertTaishoGoryeo } from "./webdist/posweb.js";
//   const src = await loadSource("./posdata/0001.json");
//   const rec = src.align("0001", 1);
//   console.log(convertTaishoGoryeo(rec, "T01p0002c0405"));
//
// Bun CLI 用法：直接 import posmap.ts / posdb.ts（可讀 posmap.db，精度與網頁完全相同）。
//
// 打包（瀏覽器只認 JS）：
//   bun build posweb.ts --target=browser --outfile=webdist/posweb.js
//
// 本檔只用到標準的 fetch / atob，沒有任何 Bun 或 Node 專屬 API。

export * from "../core/posmap";
export * from "../core/posfmt";

import { AlignSource, jsonSource, SutraJson } from "../core/posmap";

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

/** 取得一份（或數份）對照 JSON，合成一個 AlignSource */
export async function loadSource(url: string | string[], fetchFn?: FetchLike): Promise<AlignSource> {
  const f = fetchFn ?? (globalThis as any).fetch;
  if (!f) throw new Error("此環境沒有 fetch，請傳入 fetchFn");
  const urls = Array.isArray(url) ? url : [url];
  const map = new Map<string, SutraJson>();
  for (const u of urls) {
    const res = await f(u);
    if (!res.ok) throw new Error(`讀取 ${u} 失敗：HTTP ${res.status}`);
    const doc = (await res.json()) as SutraJson;
    map.set(doc.tsutra.toUpperCase(), doc);
  }
  return {
    align: (tsutra, tjuan) => {
      const doc = map.get(tsutra.toUpperCase());
      return doc ? jsonSource(doc).align(tsutra, tjuan) : null;
    },
  };
}
