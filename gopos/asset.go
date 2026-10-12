// asset.go — posmap.pos 這個 binary asset 的讀取、驗證與重新打包
//
// 版面完全依照 posasset.ts 的定義，兩邊必須一致：
//
//	0   8  magic "POSMAP\x01\x00"
//	8   2  u16 formatVersion = 2
//	10  1  u8  codec：0=無壓縮 1=deflate 2=gzip 3=zstd 4=brotli
//	11  1  u8  flags
//	12  8  u64 rawLen
//	20  8  u64 compLen
//	28  4  u32 crc32（未壓縮 payload 的 IEEE CRC-32）
//	32  4  u32 reserved
//	36  …  payload
package main

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
	"os"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/zstd"
)

const (
	posMagic         = "POSMAP\x01\x00"
	posFormatVersion = 2
	assetHeaderSize  = 36
	indexRecordSize  = 36
)

// Codec 是 payload 的壓縮方式。
type Codec byte

const (
	CodecNone    Codec = 0
	CodecDeflate Codec = 1
	CodecGzip    Codec = 2
	CodecZstd    Codec = 3
	CodecBrotli  Codec = 4
)

func (c Codec) String() string {
	switch c {
	case CodecNone:
		return "none"
	case CodecDeflate:
		return "deflate"
	case CodecGzip:
		return "gzip"
	case CodecZstd:
		return "zstd"
	case CodecBrotli:
		return "brotli"
	}
	return fmt.Sprintf("codec(%d)", byte(c))
}

// ParseCodec 解析 codec 名稱。
func ParseCodec(s string) (Codec, error) {
	switch s {
	case "none", "":
		return CodecNone, nil
	case "deflate":
		return CodecDeflate, nil
	case "gzip":
		return CodecGzip, nil
	case "zstd":
		return CodecZstd, nil
	case "brotli":
		return CodecBrotli, nil
	}
	return 0, fmt.Errorf("不認得的 codec：%s（可用 none/deflate/gzip/zstd/brotli）", s)
}

// IndexRec 是 asset 裡一卷的索引記錄。
type IndexRec struct {
	TSutra, KSutra             string
	TJuan, KJuan               int
	TVol, KVol                 int
	TStartSeq, TEndSeq         int
	KStartSeq, KEndSeq         int
	BlobOff, BlobLen           int
}

// Asset 是解開後的 asset。
type Asset struct {
	Codec   Codec
	RawLen  int
	CompLen int
	CRC     uint32
	Index   []IndexRec
	payload []byte
	blobAt  int
}

// Blob 回傳第 i 卷的 varint blob（指向 payload，不要修改）。
func (a *Asset) Blob(i int) []byte {
	r := a.Index[i]
	return a.payload[a.blobAt+r.BlobOff : a.blobAt+r.BlobOff+r.BlobLen]
}

// ReadAssetFile 讀檔並解開。
func ReadAssetFile(path string) (*Asset, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return ParseAsset(raw)
}

// ParseAsset 解析一份 asset 位元組。
func ParseAsset(raw []byte) (*Asset, error) {
	if len(raw) < assetHeaderSize {
		return nil, fmt.Errorf("檔案太短（%d bytes）", len(raw))
	}
	if string(raw[0:8]) != posMagic {
		return nil, fmt.Errorf("不是 posmap asset（magic 不符）")
	}
	ver := binary.LittleEndian.Uint16(raw[8:])
	if ver != posFormatVersion {
		return nil, fmt.Errorf("asset 版本 %d 不支援（本程式認得 %d）", ver, posFormatVersion)
	}
	codec := Codec(raw[10])
	rawLen := int(binary.LittleEndian.Uint32(raw[12:]))
	compLen := int(binary.LittleEndian.Uint32(raw[20:]))
	crc := binary.LittleEndian.Uint32(raw[28:])
	if assetHeaderSize+compLen > len(raw) {
		return nil, fmt.Errorf("payload 長度不足：宣稱 %d，實際只有 %d", compLen, len(raw)-assetHeaderSize)
	}
	body := raw[assetHeaderSize : assetHeaderSize+compLen]
	payload, err := decompress(codec, body, rawLen)
	if err != nil {
		return nil, err
	}
	if len(payload) != rawLen {
		return nil, fmt.Errorf("解壓後長度 %d ≠ 檔頭宣稱的 %d", len(payload), rawLen)
	}
	if got := crc32.ChecksumIEEE(payload); got != crc {
		return nil, fmt.Errorf("CRC-32 不符：算出 %08x、檔頭 %08x", got, crc)
	}
	a := &Asset{Codec: codec, RawLen: rawLen, CompLen: compLen, CRC: crc, payload: payload}
	if err := a.parsePayload(); err != nil {
		return nil, err
	}
	return a, nil
}

func (a *Asset) parsePayload() error {
	p := a.payload
	o := 0
	u32 := func() int {
		v := int(binary.LittleEndian.Uint32(p[o:]))
		o += 4
		return v
	}
	u16 := func() int {
		v := int(binary.LittleEndian.Uint16(p[o:]))
		o += 2
		return v
	}
	nSutras := u32()
	if o+nSutras > len(p) {
		return fmt.Errorf("經號表長度不合理")
	}
	ids := make([]string, nSutras)
	for i := 0; i < nSutras; i++ {
		n := int(p[o])
		o++
		if o+n > len(p) {
			return fmt.Errorf("經號字串超出範圍")
		}
		ids[i] = string(p[o : o+n])
		o += n
	}
	nJuans := u32()
	if o+nJuans*indexRecordSize > len(p) {
		return fmt.Errorf("索引長度不合理：%d 卷", nJuans)
	}
	a.Index = make([]IndexRec, nJuans)
	for i := 0; i < nJuans; i++ {
		ti, ki := u16(), u16()
		r := IndexRec{}
		r.TSutra, r.KSutra = ids[ti], ids[ki]
		r.TJuan, r.KJuan, r.TVol, r.KVol = u16(), u16(), u16(), u16()
		r.TStartSeq, r.TEndSeq = u32(), u32()
		r.KStartSeq, r.KEndSeq = u32(), u32()
		r.BlobOff, r.BlobLen = u32(), u32()
		a.Index[i] = r
	}
	a.blobAt = o
	return nil
}

// ---------------------------------------------------------------- 壓縮

func decompress(c Codec, body []byte, rawLen int) ([]byte, error) {
	switch c {
	case CodecNone:
		return body, nil
	case CodecGzip:
		r, err := gzip.NewReader(bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		defer r.Close()
		return io.ReadAll(r)
	case CodecDeflate:
		r := flate.NewReader(bytes.NewReader(body))
		defer r.Close()
		return io.ReadAll(r)
	case CodecZstd:
		d, err := zstd.NewReader(nil)
		if err != nil {
			return nil, err
		}
		defer d.Close()
		return d.DecodeAll(body, make([]byte, 0, rawLen))
	case CodecBrotli:
		return io.ReadAll(brotli.NewReader(bytes.NewReader(body)))
	}
	return nil, fmt.Errorf("不支援的 codec：%d", byte(c))
}

func compress(c Codec, payload []byte) ([]byte, error) {
	switch c {
	case CodecNone:
		return payload, nil
	case CodecZstd:
		e, err := zstd.NewWriter(nil, zstd.WithEncoderLevel(zstd.SpeedBestCompression))
		if err != nil {
			return nil, err
		}
		defer e.Close()
		return e.EncodeAll(payload, make([]byte, 0, len(payload)/4)), nil
	case CodecBrotli:
		var b bytes.Buffer
		w := brotli.NewWriterLevel(&b, brotli.BestCompression)
		if _, err := w.Write(payload); err != nil {
			return nil, err
		}
		if err := w.Close(); err != nil {
			return nil, err
		}
		return b.Bytes(), nil
	case CodecGzip:
		var b bytes.Buffer
		w := gzip.NewWriter(&b)
		if _, err := w.Write(payload); err != nil {
			return nil, err
		}
		if err := w.Close(); err != nil {
			return nil, err
		}
		return b.Bytes(), nil
	case CodecDeflate:
		var b bytes.Buffer
		w, err := flate.NewWriter(&b, flate.BestCompression)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(payload); err != nil {
			return nil, err
		}
		if err := w.Close(); err != nil {
			return nil, err
		}
		return b.Bytes(), nil
	}
	return nil, fmt.Errorf("不支援的 codec：%d", byte(c))
}

// WriteAssetFile 把 payload 以指定 codec 重新打包成 asset 檔。
func WriteAssetFile(path string, payload []byte, c Codec) (int, error) {
	comp, err := compress(c, payload)
	if err != nil {
		return 0, err
	}
	out := make([]byte, assetHeaderSize+len(comp))
	copy(out[0:8], posMagic)
	binary.LittleEndian.PutUint16(out[8:], posFormatVersion)
	out[10] = byte(c)
	out[11] = 0
	binary.LittleEndian.PutUint64(out[12:], uint64(len(payload)))
	binary.LittleEndian.PutUint64(out[20:], uint64(len(comp)))
	binary.LittleEndian.PutUint32(out[28:], crc32.ChecksumIEEE(payload))
	binary.LittleEndian.PutUint32(out[32:], 0)
	copy(out[assetHeaderSize:], comp)
	if err := os.WriteFile(path, out, 0o644); err != nil {
		return 0, err
	}
	return len(out), nil
}
