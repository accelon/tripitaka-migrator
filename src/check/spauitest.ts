// spauitest.ts — 用模擬 DOM 實際跑一遍 SPA 的介面流程，找出經文為何沒顯示
const html = await Bun.file("public/tripitaka-migrator.html").text();
const s0 = html.lastIndexOf("<script>") + 8, s1 = html.lastIndexOf("</script>");
let script = html.slice(s0, s1);
script = script.replace(/\(async \(\) => \{[\s\S]*$/, "");

// 每個 id 給獨立的元素
const els = new Map<string, any>();
const attrs = new Map<string, string>();
const mk = (id: string) => {
  let html = "";
  const o: any = {
    id, textContent: "", title: "", value: "",
    get innerHTML() { return html; },
    set innerHTML(v: string) { html = v; const m = /<option value="([^"]*)"/.exec(v); o.value = m ? m[1] : ""; },
    addEventListener() {}, closest: () => null,
    setAttribute(k: string, v: string) { attrs.set(id + ":" + k, v); },
    getAttribute(k: string) { return attrs.get(id + ":" + k) ?? null; },
  };
  return o;
};
const root: any = { _t: "light", setAttribute(k: string, v: string) { if (k === "data-theme") this._t = v; }, getAttribute() { return this._t; } };
const doc: any = {
  documentElement: root,
  getElementById: (id: string) => { if (!els.has(id)) els.set(id, mk(id)); return els.get(id); },
};
const api = new Function("document", script + "\nreturn { load, convertT, init, renderSample, renderFor, applyTheme, currentTheme, cascadeFromVol, cascadeFromSutra, pickerChanged, SAMPLES, SUTRAS: () => SUTRAS, VOLS: () => VOLS, IDX: () => IDX };")(doc) as any;

console.log("SAMPLES 是陣列嗎：", Array.isArray(api.SAMPLES), "長度", api.SAMPLES?.length);
await api.load();
console.log("資產載入完成，卷數", api.IDX().length);

console.log("\n--- 呼叫 init() ---");
try {
  api.init();
console.log("下拉選單建構:");
console.log("  冊選項數:", (doc.getElementById("selVol").innerHTML.match(/<option/g) || []).length);
console.log("  冊前 6:", (doc.getElementById("selVol").innerHTML.match(/>([^<]+)</g) || []).slice(0, 6).join(" "));
console.log("  經選項數:", (doc.getElementById("selSutra").innerHTML.match(/<option/g) || []).length, "（已依冊篩選）");
console.log("  經前 3:", (doc.getElementById("selSutra").innerHTML.match(/>([^<]+)</g) || []).slice(0, 3).join(" "));
console.log("  卷選項:", doc.getElementById("selJuan").innerHTML.replace(/<[^>]+>/g, "|").slice(0, 60));
console.log("  頁選項:", doc.getElementById("selPage").innerHTML.slice(0, 90));
console.log("  欄選項:", doc.getElementById("selCol").innerHTML.replace(/<[^>]+>/g, "|"));
console.log("  行選項數:", (doc.getElementById("selLine").innerHTML.match(/<option/g) || []).length, " 前幾個:", (doc.getElementById("selLine").innerHTML.match(/>(\d\d)</g) || []).slice(0, 5).join(" "));
console.log("  addr 值:", doc.getElementById("addr").value);
console.log("  卷/頁/欄/行 =", doc.getElementById("selJuan").value, "/", doc.getElementById("selPage").value, "/", doc.getElementById("selCol").value, "/", doc.getElementById("selLine").value);
// 模擬：選第 6 冊
console.log("\n--- 模擬選「第 6 冊」---");
for (const v of ["6","7","1"]) {
  doc.getElementById("selVol").value = v;
  api.cascadeFromVol();
  api.pickerChanged();
  const so = (doc.getElementById("selSutra").innerHTML.match(/>([^<]+)</g) || []).map((x: string) => x.slice(1, -1));
  const jo = (doc.getElementById("selJuan").innerHTML.match(/>([^<]+)</g) || []).map((x: string) => x.slice(1, -1));
  console.log("  第 " + v + " 冊 → 經 " + so.length + " 部：" + so.slice(0, 3).join(" / "));
  console.log("      卷 " + jo.length + " 個：" + jo.slice(0, 3).join(" ") + " … " + jo.slice(-2).join(" "));
  console.log("      欄選項 = " + doc.getElementById("selCol").innerHTML.replace(/<[^>]+>/g, "|"));
  console.log("      目前選中 卷=" + doc.getElementById("selJuan").value + " 位址=" + doc.getElementById("addr").value);
}
// 手動輸入一個不在範例內的位址，檢查訊息用字
doc.getElementById("addr").value = "T01p0005b0503";
api.renderFor("T01p0005b0503");
const nt = doc.getElementById("text").innerHTML;
console.log("無庫存訊息:", nt.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
console.log("主題按鈕文字:", JSON.stringify(doc.getElementById("theme").textContent), " / aria-pressed =", doc.getElementById("theme").getAttribute("aria-pressed"), " / title =", doc.getElementById("theme").title);
api.applyTheme("dark");
console.log("切暗底後按鈕文字:", JSON.stringify(doc.getElementById("theme").textContent), " / aria-pressed =", doc.getElementById("theme").getAttribute("aria-pressed"));
console.log("切到暗底後 data-theme =", doc.documentElement.getAttribute("data-theme"));
  console.log("init() 沒有拋錯");
} catch (e: any) {
  console.log("init() 拋錯：", e.message, "\n", e.stack?.split("\n").slice(0, 4).join("\n"));
}
const text = doc.getElementById("text").innerHTML;
const res = doc.getElementById("result").innerHTML;
console.log("\n#text 長度:", text.length);
console.log("#text 前 300 字元:\n", text.slice(0, 300));
console.log("\n#result 長度:", res.length);
console.log("\n#result 內的連結:");
for (const m of res.matchAll(/<a href="([^"]+)"[^>]*>([^<]*)</g)) console.log("   " + m[2].trim() + "  →  " + m[1]);
console.log("\n經文行的連結（第一組）:");
api.renderSample(api.SAMPLES[0]);
const text2 = doc.getElementById("text").innerHTML;
const pi2 = text2.indexOf('<div class="pair">');
for (const m of text2.slice(pi2, pi2 + 4000).matchAll(/<a[^>]*href="([^"]+)"[^>]*>/g)) console.log("   " + m[1]);
const pi = text.indexOf('<div class="pair">');
console.log("\n第一組 pair 的原始標記:\n", text.slice(pi, pi + 460));
let c = 0, q = pi; while (c < 4 && q >= 0) { q = text.indexOf('<div class="pair">', q + 1); c++; }
console.log("\n第四組 pair（kOff=3，看得出深淺分段）:\n", text.slice(q, q + 480));
console.log("\n#addr.value =", doc.getElementById("addr").value);
