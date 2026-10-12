// format.go — 單卷對齊 blob 的解碼
//
// blob 由 posmap.ts 的 encodeAlign 產生，全部是 LEB128 無號 varint：
//
//	u8  版本 = 1
//	u8  flags（bit0 = 對齊粗略）
//	geom(t)、geom(k)
//	u32 tBody0, tBody1, tPre, tPost
//	u32 kBody0, kBody1, kPre, kPost
//	u32 nRuns；重複：u32 gapT, u32 gapK, u32 len
//
// geom：
//
//	u32 vol, u32 nLines, u32 han
//	nLines × u32 dseq（相對上一行的 seq 差）
//	nLines × u32 該行漢字數
package main

import "fmt"

const alignBlobVersion = 1

// SideGeom 是一側（大正藏或高麗藏）某卷的行幾何。
type SideGeom struct {
	Vol       int
	LineSeq   []int32 // 每行的 seq，嚴格遞增
	LineStart []int32 // 每行在該卷漢字序列中的起點，長度 = 行數+1
	Han       int     // 總漢字數
}

// AlignBody 是一卷的對齊資料。
type AlignBody struct {
	T, K                   SideGeom
	TBody, KBody           [2]int32 // 可對照的字元區間 [起, 訖)
	TPre, TPost, KPre, KPost int32
	Runs                   []int32 // 每 3 個為 (tStart, kStart, len)
	Coarse                 bool
}

// AlignRec 是 AlignBody 加上經卷識別。
type AlignRec struct {
	TSutra, KSutra string
	TJuan, KJuan   int
	AlignBody
}

type varReader struct {
	b []byte
	o int
}

func (r *varReader) u8() int {
	v := int(r.b[r.o])
	r.o++
	return v
}

func (r *varReader) u32() int {
	var v uint64
	var shift uint
	for {
		c := r.b[r.o]
		r.o++
		v |= uint64(c&0x7f) << shift
		if c&0x80 == 0 {
			break
		}
		shift += 7
	}
	return int(v)
}

func readGeom(r *varReader) (SideGeom, error) {
	g := SideGeom{}
	g.Vol = r.u32()
	n := r.u32()
	g.Han = r.u32()
	if n < 0 || r.o+n*4 > len(r.b)+len(r.b) {
		// 只做粗略合理性檢查，真正的越界由下面的讀取自然 panic→由 recover 處理
	}
	g.LineSeq = make([]int32, n)
	g.LineStart = make([]int32, n+1)
	prev := 0
	for i := 0; i < n; i++ {
		prev += r.u32()
		g.LineSeq[i] = int32(prev)
	}
	acc := 0
	for i := 0; i < n; i++ {
		g.LineStart[i] = int32(acc)
		acc += r.u32()
	}
	g.LineStart[n] = int32(acc)
	return g, nil
}

// DecodeAlign 解開一卷的 blob。
func DecodeAlign(b []byte) (body AlignBody, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("對齊 blob 解碼失敗（可能損毀）：%v", r)
		}
	}()
	r := &varReader{b: b}
	if v := r.u8(); v != alignBlobVersion {
		return body, fmt.Errorf("對齊 blob 版本 %d 不支援", v)
	}
	flags := r.u8()
	var e error
	if body.T, e = readGeom(r); e != nil {
		return body, e
	}
	if body.K, e = readGeom(r); e != nil {
		return body, e
	}
	body.TBody = [2]int32{int32(r.u32()), int32(r.u32())}
	body.TPre, body.TPost = int32(r.u32()), int32(r.u32())
	body.KBody = [2]int32{int32(r.u32()), int32(r.u32())}
	body.KPre, body.KPost = int32(r.u32()), int32(r.u32())
	nRuns := r.u32()
	body.Runs = make([]int32, nRuns*3)
	pt, pk := 0, 0
	for i := 0; i < nRuns; i++ {
		t0 := pt + r.u32()
		k0 := pk + r.u32()
		l := r.u32()
		body.Runs[i*3] = int32(t0)
		body.Runs[i*3+1] = int32(k0)
		body.Runs[i*3+2] = int32(l)
		pt, pk = t0+l, k0+l
	}
	body.Coarse = flags&1 != 0
	return body, nil
}
