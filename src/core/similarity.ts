// similarity.ts — 經卷比對：Myers diff、正文/序言/附文判定、相似度
//
// 設計要點（對應 juanmap.md 的三個約束）：
//   1. 卷首若有一大段只出現在單邊的文字，判為序文；卷末同理判為附文。
//      正文起點＝第一個「夠長且完全相同的片段」的開頭（分段邊界必定落在片段邊界上）。
//   2. 標點、標記不是漢字，在正規化階段就被剔除，因此不計為差異。
//   3. diff 的變動區塊中，若同時有刪除與新增，先按位置配對成「替代」；
//      只有配對不上的多餘字數才算新增／刪除。故「峰/峯」這類異體字不計為差異。
//
// 相似度定義：
//   對齊長度 = 相同 + 替代 + 新增 + 刪除
//   相似度   = (相同 + 替代) / 對齊長度      ← 替代不計差異（符合約束 3）
//   嚴格相似度 = 相同 / 對齊長度             ← 把替代也算差異，供對照
//   兩者都只計正文，序文與附文的長度差另以欄位呈現。

/** 對齊片段：t 為 = / - / +，aStart/bStart 為在 A/B 中的起點，len 為長度 */
export interface Seg { t: "=" | "-" | "+"; aStart: number; bStart: number; len: number }

const MAX_D = 4000;   // Myers 搜尋上限（安全閥）。trace 記憶體約 D²/2 個 int，D=4000 約 32MB

/** Myers O(ND) 最短編輯脚本，回傳已合併的片段序列 */
export function myersDiff(a: string, b: string): Seg[] {
  // 先去掉共同前後綴（兩版本高度相同，這一步就能砍掉絕大部分）
  let p = 0;
  const minLen = Math.min(a.length, b.length);
  while (p < minLen && a[p] === b[p]) p++;
  let s = 0;
  while (s < minLen - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;

  const segs: Seg[] = [];
  /** 依序附加單一字元，並與前一同型片段合併 */
  let ai = 0, bi = 0;
  const append = (t: Seg["t"]) => {
    const last = segs[segs.length - 1];
    if (last && last.t === t) last.len++;
    else segs.push({ t, aStart: ai, bStart: bi, len: 1 });
    if (t !== "+") ai++;
    if (t !== "-") bi++;
  };
  const appendRun = (t: Seg["t"], len: number) => { for (let k = 0; k < len; k++) append(t); };

  appendRun("=", p);

  const A = a.slice(p, a.length - s);
  const B = b.slice(p, b.length - s);
  const N = A.length, M = B.length;

  if (N === 0 || M === 0) {
    appendRun("-", N);
    appendRun("+", M);
  } else {
    // Myers O(ND)。trace 只保存每個 d 實際用到的 k 線（2d+1 個），
    // 記憶體由 O(D·(N+M)) 降到 O(D²)，因此長卷也能精確比對而不必退化。
    const off = N + M + 1;
    const v = new Int32Array(2 * (N + M) + 3);
    const trace: (Int32Array | null)[] = [null];   // trace[d] = 第 d-1 輪之後的 k 線狀態
    let D = -1;
    const limit = Math.min(N + M, MAX_D);
    for (let d = 0; d <= limit; d++) {
      if (d > 0) {
        const snap = new Int32Array(d);
        for (let k = -(d - 1), idx = 0; k <= d - 1; k += 2, idx++) snap[idx] = v[off + k];
        trace.push(snap);
      }
      for (let k = -d; k <= d; k += 2) {
        let x: number;
        if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
        else x = v[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && A[x] === B[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= N && y >= M) { D = d; break; }
      }
      if (D >= 0) break;
    }

    if (D < 0) {
      // 安全閥觸發（差異超過 MAX_D）：退化為單一變動區塊，並由呼叫端標記為粗略對齊
      appendRun("-", N);
      appendRun("+", M);
    } else {
      // 回溯編輯路径（由後往前），再反轉
      const back: ("-" | "+" | "=")[] = [];
      let x = N, y = M;
      for (let d = D; d > 0; d--) {
        const snap = trace[d]!;
        const k = x - y;
        const prevK = (k === -d || (k !== d && snap[(k - 1 + d - 1) >> 1] < snap[(k + 1 + d - 1) >> 1])) ? k + 1 : k - 1;
        const prevX = snap[(prevK + d - 1) >> 1];
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) { back.push("="); x--; y--; }
        if (x > prevX) { back.push("-"); x--; }
        else { back.push("+"); y--; }
      }
      while (x > 0 && y > 0) { back.push("="); x--; y--; }
      while (x > 0) { back.push("-"); x--; }
      while (y > 0) { back.push("+"); y--; }
      for (let k = back.length - 1; k >= 0; k--) append(back[k]);
    }
  }

  appendRun("=", s);
  return segs;
}

/** Myers 長度下限：連續相同這麼多字才算「正文」的可靠錨點 */
export const ANCHOR = 20;
/** 序文／附文至少要有這麼多漢字才認定 */
export const MIN_PRE = 12;

export interface JuanDiff {
  /** K 全卷漢字數 */
  hanA: number;
  /** T 全卷漢字數 */
  hanB: number;
  /** 相同字數（正文） */
  matched: number;
  /** 替代字數（正文） */
  substituted: number;
  /** 新增字數（T 有 K 無，正文） */
  inserted: number;
  /** 刪除字數（K 有 T 無，正文） */
  deleted: number;
  /** (matched+substituted)/aligned */
  similarity: number;
  /** matched/aligned */
  strictSimilarity: number;
  /** 正文起點（在各自漢字序列中的位移） */
  bodyStartA: number;
  bodyStartB: number;
  bodyEndA: number;
  bodyEndB: number;
  /** 序言漢字數：K / T */
  preA: number;
  preB: number;
  /** 附文漢字數：K / T */
  postA: number;
  postB: number;
  /** 正文字數（K / T） */
  bodyA: number;
  bodyB: number;
  /** 序言區內兩藏完全相同的字數（用來判斷該區是「各自不同的序」還是被邊界吸收的正文） */
  matchedPre: number;
  /** 附文區內兩藏完全相同的字數 */
  matchedPost: number;
  /** 是否因安全閥退化為粗略對齊 */
  coarse: boolean;
}

/** 正文邊界：headA/headB 為正文起點，tailA/tailB 為正文終點（各自座標系） */
export interface BodyBounds { headA: number; headB: number; tailA: number; tailB: number }

/**
 * 由編輯脚本求正文邊界：正文起點＝第一個「夠長且完全相同」片段的開頭，
 * 正文終點＝最後一個這類片段的結尾。序文／附文必定落在這兩個邊界之外。
 * 邊界一定落在片段邊界上，這是位置對照能精確到字的前提。
 */
export function bodyBoundsOf(segs: Seg[], lenA: number, lenB: number): BodyBounds {
  let headA = 0, headB = 0, tailA = lenA, tailB = lenB;
  const eqRuns = segs.filter(sg => sg.t === "=" && sg.len >= ANCHOR);
  if (eqRuns.length > 0) {
    const first = eqRuns[0];
    if (first.aStart + first.bStart >= MIN_PRE) { headA = first.aStart; headB = first.bStart; }
    const last = eqRuns[eqRuns.length - 1];
    const postLen = (lenA - (last.aStart + last.len)) + (lenB - (last.bStart + last.len));
    if (postLen >= MIN_PRE) { tailA = last.aStart + last.len; tailB = last.bStart + last.len; }
    if (tailA < headA || tailB < headB) { tailA = lenA; tailB = lenB; }
  }
  return { headA, headB, tailA, tailB };
}

/** 1:1 對應段：k = A 側（高麗藏）位移，t = B 側（大正藏）位移 */
export interface AlignRun {
  t: number; k: number; len: number;
  /** true = 由變動區塊內的刪除／新增按位置配對而成（即「替代」字）；false = 完全相同的片段 */
  paired: boolean;
}

/**
 * 把編輯脚本轉成 1:1 的對應段（source map 的 mappings）。
 * 變動區塊內若同時有刪除與新增，按位置配對成「替代」（與 compareHanzi 的替代統計一致），
 * 這些替代字一樣是一對一的，所以照樣進對應段——「峰/峯」這類異體字才不會斷掉對照。
 * 只有配對不上的多餘字（單邊插文）才沒有對應。
 *
 * 註：一個變動區塊內，所有刪除段在 A 側連續、所有新增段在 B 側連續
 *（彼此之間只隔著另一側的片段），故配對後在兩側都仍是連續區間。
 */
export function buildAlignment(segs: Seg[]): AlignRun[] {
  const runs: AlignRun[] = [];
  let i = 0;
  while (i < segs.length) {
    const sg = segs[i];
    if (sg.t === "=") {
      runs.push({ t: sg.bStart, k: sg.aStart, len: sg.len, paired: false });
      i++;
      continue;
    }
    let dStart = -1, dLen = 0, iStart = -1, iLen = 0;
    while (i < segs.length && segs[i].t !== "=") {
      const c = segs[i];
      if (c.t === "-") { if (dStart < 0) dStart = c.aStart; dLen += c.len; }
      else { if (iStart < 0) iStart = c.bStart; iLen += c.len; }
      i++;
    }
    const pair = Math.min(dLen, iLen);
    if (pair > 0) runs.push({ t: iStart, k: dStart, len: pair, paired: true });
  }
  runs.sort((x, y) => x.t - y.t);
  return runs;
}

export function compareHanzi(A: string, B: string, segsIn?: Seg[]): JuanDiff {
  const segs = segsIn ?? myersDiff(A, B);

  // ---- 1. 找正文邊界 ----
  const { headA, headB, tailA, tailB } = bodyBoundsOf(segs, A.length, B.length);

  // ---- 2. 統計正文內的對齊結果 ----
  // 邊界必定落在片段邊界上，故只需挑出完全落在正文內的片段。
  let matched = 0, substituted = 0, inserted = 0, deleted = 0;
  let matchedPre = 0, matchedPost = 0;
  let i = 0;
  while (i < segs.length) {
    const sg = segs[i];
    if (sg.t === "=") {
      const end = sg.aStart + sg.len;
      if (end <= headA) matchedPre += sg.len;                       // 序言區內的相同字
      else if (sg.aStart >= tailA) matchedPost += sg.len;           // 附文區內的相同字
      else if (sg.aStart >= headA && end <= tailA) matched += sg.len;
      i++;
      continue;
    }
    // 收集一個完整變動區塊（連續的 - 與 +）
    let lD = 0, lI = 0;
    let aStart = sg.aStart, bStart = sg.bStart;
    let aEnd = sg.aStart, bEnd = sg.bStart;
    let inBody = true;
    while (i < segs.length && segs[i].t !== "=") {
      const c = segs[i];
      if (c.t === "-") { lD += c.len; aEnd = c.aStart + c.len; aStart = Math.min(aStart, c.aStart); }
      else { lI += c.len; bEnd = c.bStart + c.len; bStart = Math.min(bStart, c.bStart); }
      i++;
    }
    if (aStart < headA || aEnd > tailA || bStart < headB || bEnd > tailB) inBody = false;
    if (!inBody) continue;   // 序文／附文內的變動不計入正文相似度
    const sub = Math.min(lD, lI);
    substituted += sub;
    deleted += lD - sub;
    inserted += lI - sub;
  }

  const aligned = matched + substituted + inserted + deleted;
  const similarity = aligned > 0 ? (matched + substituted) / aligned : 1;
  const strictSimilarity = aligned > 0 ? matched / aligned : 1;

  // 粗略對齊＝完全相同（未經替代配對）的字數不到較短一邊的一半。
  // 這代表兩邊文字幾乎對不上（錯配、或版本差異極大），此時「替代」會把差異
  // 全部吸收掉而讓相似度虛高，必須靠這個標記提醒。
  const shorter = Math.min(A.length, B.length);
  const coarse = shorter > 0 && matched < 0.5 * shorter;

  return {
    hanA: A.length, hanB: B.length,
    matched, substituted, inserted, deleted,
    similarity, strictSimilarity,
    bodyStartA: headA, bodyStartB: headB, bodyEndA: tailA, bodyEndB: tailB,
    preA: headA, preB: headB,
    postA: A.length - tailA, postB: B.length - tailB,
    bodyA: tailA - headA, bodyB: tailB - headB,
    matchedPre, matchedPost,
    coarse,
  };
}
