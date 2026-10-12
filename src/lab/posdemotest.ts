// posdemotest.ts — 把 posdemo.html 裡那段 module 程式抽出來，用假的 DOM 與 fetch 跑一遍
//
//   bun posdemotest.ts
//
// 目的：示範頁的程式無法在 CI 裡開瀏覽器，但可以先確認它「語法可編譯、載入 JSON 成功、
// 轉換結果正確、錯誤訊息走對分支」。抽取出的暫存檔會在結束時刪掉。

import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

const ROOT = import.meta.dir;
const GEN = join(ROOT, "_posdemo.generated.mjs");

const html = readFileSync(join(ROOT, "posdemo.html"), "utf-8");
const m = /<script type="module">([\s\S]*?)<\/script>/.exec(html);
if (!m) { console.error("✗ posdemo.html 找不到 module script"); process.exit(1); }
writeFileSync(GEN, m[1], "utf-8");

let pass = 0, fail = 0;
const check = (cond: boolean, what: string, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${what}`); }
  else { fail++; console.log(`  ✗ ${what}${extra ? "  " + extra : ""}`); }
};

// ---- 假 DOM ----
const mk = (id: string) => ({
  id, value: "", innerHTML: "", hidden: true, disabled: false,
  handlers: {} as Record<string, Function>,
  addEventListener(e: string, f: Function) { this.handlers[e] = f; },
});
const els: Record<string, any> = { addr: mk("addr"), go: mk("go"), out: mk("out"), hint: mk("hint") };
(globalThis as any).document = {
  getElementById: (id: string) => els[id],
  querySelectorAll: () => [],
};

// ---- 假 fetch：把 ./posdata/0001.json 從磁碟讀進來 ----
let fetchCount = 0;
(globalThis as any).fetch = async (u: string) => {
  fetchCount++;
  const p = join(ROOT, u.replace(/^\.\//, ""));
  const t = readFileSync(p, "utf-8");
  return { ok: true, status: 200, json: async () => JSON.parse(t), text: async () => t };
};

await import(GEN);

const run = async (addr: string) => {
  els.addr.value = addr;
  els.out.innerHTML = "";
  els.hint.hidden = true;
  await els.go.handlers.click();
  await new Promise(r => setTimeout(r, 50));
  return String(els.out.innerHTML).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
};

console.log("posdemo.html 示範頁邏輯：");
const t1 = await run("T01p0002c0405");
check(t1.includes("K17p0816b1300"), "T01p0002c0405 → K17p0816b1300", t1);
check(t1.includes("0002c04 第 5 字"), "顯示行內偏置", t1);

const t2 = await run("T01p0001a0500");
check(t2.includes("K17p0815a0300"), "序文 → 正文第一字", t2);
check(t2.includes("T01p0001b1101"), "回報修正後的大正藏位置", t2);
check(t2.includes("preface"), "標明調整原因", t2);

const t3 = await run("T01p0011a0100");
check(t3.includes("K17p0826a2200"), "卷末位置精確對應", t3);

const t4 = await run("亂七八糟");
check(t4.includes("位址無法解析"), "非法位址走錯誤分支", t4);

const t5 = await run("K17p0815a0301");
check(t5.includes("請輸入大正藏位址"), "拒絕非大正藏位址", t5);

const t6 = await run("T01p0005a0100");
check(t6.includes("K17"), "未收錄頁碼仍能定位", t6);

check(fetchCount <= 2, `JSON 只載入一次（實際 fetch ${fetchCount} 次）`);

unlinkSync(GEN);
console.log(`\n通過 ${pass}、失敗 ${fail}`);
process.exit(fail ? 1 : 0);
