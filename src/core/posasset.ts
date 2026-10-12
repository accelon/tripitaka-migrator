// posasset.ts — 位置對照的單一 binary asset 檔（posmap.pos）
//
// 這個檔就是「把 diff 位置結構存成一個檔案」：一份檔頭、一張索引、一段接一段的
// varint blob，整段用 zstd（或 gzip／不壓）包起來。Bun 負責寫，Go 負責讀（見 gopos/）。
//
// ============================ 版面 ============================
// 全部 little-endian。
//
//   位移  長度  欄位
//   0     8     magic = "POSMAP\x01\x00"
//   8     2     u16 formatVersion = 2
//   10    1     u8  codec：0=無壓縮 1=deflate 2=gzip 3=zstd 4=brotli
//   11    1     u8  flags（保留，目前 0）
//   12    8     u64 rawLen   未壓縮 payload 的位元組數
//   20    8     u64 compLen  壓縮後 payload 的位元組數（codec=0 時同 rawLen）
//   28    4     u32 crc32    未壓縮 payload 的 CRC-32（IEEE，同 Go 的 crc32.IEEE）
//   32    4     u32 reserved
//   36    ...   payload[compLen]
//
// payload（未壓縮）：
//   u32 nSutras
//   nSutras × (u8 len + len bytes ASCII)      經號字串表，如 "0001"、"0647"
//   u32 nJuans
//   nJuans × 36 bytes                          索引，依 tsutra、tjuan 排序
//   blob 區                                    各卷的 varint blob，依 blobOff 相接
//
// 索引記錄（36 bytes）：
//   u16 tsutraIdx   經號字串表的索引
//   u16 ksutraIdx
//   u16 tjuan       大正藏卷號
//   u16 kjuan       高麗藏卷號
//   u16 tVol        大正藏冊號
//   u16 kVol        高麗藏冊號
//   u32 tStartSeq / tEndSeq / kStartSeq / kEndSeq   頁欄行流水號範圍，用來由「冊+頁碼」找卷
//   u32 blobOff     相對 blob 區起點的位移
//   u32 blobLen
//
// 各卷 blob 的內部佈局見 posmap.ts 的 encodeAlign（LEB128 varint）。

import { Database } from "bun:sqlite";
import { writeFileSync, statSync } from "fs";
import { normSutra } from "./juanindex";

export const POS_MAGIC = "POSMAP\x01\x00";
export const POS_FORMAT_VERSION = 2;

export const CODEC = { none: 0, deflate: 1, gzip: 2, zstd: 3, brotli: 4 } as const;
export type CodecName = keyof typeof CODEC;

export const INDEX_RECORD_SIZE = 36;

// ---------------------------------------------------------------- CRC-32（IEEE）

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- 小工具

class Buf {
  private a: Uint8Array;
  private n = 0;
  constructor(cap = 1 << 16) { this.a = new Uint8Array(cap); }
  private fit(k: number) {
    if (this.n + k <= this.a.length) return;
    let c = this.a.length * 2;
    while (c < this.n + k) c *= 2;
    const b = new Uint8Array(c);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  u8(v: number) { this.fit(1); this.a[this.n++] = v & 0xff; }
  u16(v: number) { this.fit(2); this.a[this.n++] = v & 0xff; this.a[this.n++] = (v >>> 8) & 0xff; }
  u32(v: number) { this.fit(4); for (let i = 0; i < 4; i++) this.a[this.n++] = (v >>> (8 * i)) & 0xff; }
  bytes(b: Uint8Array) { this.fit(b.length); this.a.set(b, this.n); this.n += b.length; }
  get length() { return this.n; }
  patch32(off: number, v: number) { for (let i = 0; i < 4; i++) this.a[off + i] = (v >>> (8 * i)) & 0xff; }
  patch64(off: number, v: number) { for (let i = 0; i < 8; i++) this.a[off + i] = Math.floor(v / 2 ** (8 * i)) & 0xff; }
  done(): Uint8Array { return this.a.slice(0, this.n); }
}

function compress(buf: Uint8Array, codec: CodecName): Uint8Array {
  switch (codec) {
    case "none": return buf;
    case "gzip": return Bun.gzipSync(buf);
    case "zstd": return new Uint8Array(Bun.zstdCompressSync(buf, { level: 19 }));
    default: throw new Error(`Bun 端不支援的 codec：${codec}（可用 gopos 的 pack 指令改用 brotli）`);
  }
}

// ---------------------------------------------------------------- 寫檔

export interface AssetStat { juans: number; sutras: number; rawLen: number; compLen: number; codec: CodecName }

export function writePosAsset(db: Database, outPath: string, codec: CodecName = "zstd"): AssetStat {
  const rows = db.query(`
    SELECT tsutra, tjuan, ksutra, kjuan, t_vol, k_vol,
           t_start_seq, t_end_seq, k_start_seq, k_end_seq, data
    FROM align ORDER BY tsutra, tjuan
  `).all() as any[];
  if (rows.length === 0) throw new Error("posmap.db 裡沒有資料");

  // 經號字串表
  const ids: string[] = [];
  const idOf = new Map<string, number>();
  const intern = (s: string) => {
    let i = idOf.get(s);
    if (i === undefined) { i = ids.length; ids.push(s); idOf.set(s, i); }
    return i;
  };
  for (const r of rows) { intern(r.tsutra); intern(r.ksutra); }
  if (ids.length > 65535) throw new Error("經號字串表超過 u16");

  // blob 區
  const blobs: Uint8Array[] = [];
  let blobTotal = 0;
  for (const r of rows) {
    const b = new Uint8Array(r.data);
    blobs.push(b);
    blobTotal += b.length;
  }

  const p = new Buf(blobTotal + rows.length * INDEX_RECORD_SIZE + 4096);
  p.u32(ids.length);
  for (const s of ids) {
    const b = new TextEncoder().encode(s);
    if (b.length > 255) throw new Error("經號太長");
    p.u8(b.length);
    p.bytes(b);
  }
  p.u32(rows.length);
  let off = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    p.u16(intern(r.tsutra)); p.u16(intern(r.ksutra));
    p.u16(r.tjuan); p.u16(r.kjuan); p.u16(r.t_vol); p.u16(r.k_vol);
    p.u32(r.t_start_seq); p.u32(r.t_end_seq); p.u32(r.k_start_seq); p.u32(r.k_end_seq);
    p.u32(off); p.u32(blobs[i].length);
    off += blobs[i].length;
  }
  for (const b of blobs) p.bytes(b);

  const payload = p.done();
  const comp = compress(payload, codec);

  // 檔頭（36 bytes）
  const h = new Buf(36);
  for (const ch of POS_MAGIC) h.u8(ch.charCodeAt(0));
  h.u16(POS_FORMAT_VERSION);
  h.u8(CODEC[codec]);
  h.u8(0);
  h.u32(payload.length & 0xffffffff);
  h.u32(Math.floor(payload.length / 2 ** 32));
  h.u32(comp.length & 0xffffffff);
  h.u32(Math.floor(comp.length / 2 ** 32));
  h.u32(crc32(payload));
  h.u32(0);
  const header = h.done();

  const out = new Uint8Array(header.length + comp.length);
  out.set(header, 0);
  out.set(comp, header.length);
  writeFileSync(outPath, out);

  return { juans: rows.length, sutras: new Set(rows.map(r => r.tsutra)).size, rawLen: payload.length, compLen: comp.length, codec };
}

// ---------------------------------------------------------------- 讀檔（驗證用；Go 端另有實作）

export interface AssetIndex {
  tsutra: string; tjuan: number; ksutra: string; kjuan: number;
  tVol: number; kVol: number;
  tStartSeq: number; tEndSeq: number; kStartSeq: number; kEndSeq: number;
  blobOff: number; blobLen: number;
}

export interface PosAsset {
  codec: number; rawLen: number; compLen: number; crc: number;
  index: AssetIndex[];
  blobRegion: Uint8Array;
  blobBase: number;
  blob(i: number): Uint8Array;
}

export function readPosAsset(bytes: Uint8Array): PosAsset {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== POS_MAGIC) throw new Error("不是 posmap asset（magic 不符）");
  const version = dv.getUint16(8, true);
  if (version !== POS_FORMAT_VERSION) throw new Error(`asset 版本 ${version} 不支援`);
  const codec = dv.getUint8(10);
  const rawLen = dv.getUint32(12, true);
  const compLen = dv.getUint32(20, true);
  const crc = dv.getUint32(28, true);
  const body = bytes.subarray(36, 36 + compLen);
  let payload: Uint8Array;
  if (codec === CODEC.none) payload = body;
  else if (codec === CODEC.gzip) payload = Bun.gunzipSync(body);
  else if (codec === CODEC.zstd) payload = new Uint8Array(Bun.zstdDecompressSync(body));
  else throw new Error(`Bun 端不支援解開 codec=${codec}`);
  if (payload.length !== rawLen) throw new Error("解壓後長度不符");
  if (crc32(payload) !== crc) throw new Error("CRC-32 不符");

  let o = 0;
  const rd32 = () => { const v = (payload[o] | (payload[o + 1] << 8) | (payload[o + 2] << 16) | (payload[o + 3] * 2 ** 24)) >>> 0; o += 4; return v; };
  const rd16 = () => { const v = payload[o] | (payload[o + 1] << 8); o += 2; return v; };
  const nSutras = rd32();
  const ids: string[] = [];
  const dec = new TextDecoder();
  for (let i = 0; i < nSutras; i++) { const n = payload[o++]; ids.push(dec.decode(payload.subarray(o, o + n))); o += n; }
  const nJuans = rd32();
  const index: AssetIndex[] = [];
  for (let i = 0; i < nJuans; i++) {
    const ts = ids[rd16()], ks = ids[rd16()];
    const tjuan = rd16(), kjuan = rd16(), tVol = rd16(), kVol = rd16();
    const tStartSeq = rd32(), tEndSeq = rd32(), kStartSeq = rd32(), kEndSeq = rd32();
    const blobOff = rd32(), blobLen = rd32();
    index.push({ tsutra: ts, tjuan, ksutra: ks, kjuan, tVol, kVol, tStartSeq, tEndSeq, kStartSeq, kEndSeq, blobOff, blobLen });
  }
  const blobBase = o;
  return {
    codec, rawLen, compLen, crc, index, blobRegion: payload, blobBase,
    blob: (i: number) => payload.subarray(blobBase + index[i].blobOff, blobBase + index[i].blobOff + index[i].blobLen),
  };
}
