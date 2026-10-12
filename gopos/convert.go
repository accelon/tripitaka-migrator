// convert.go — 位置換算演算法（與 posmap.ts 逐條對應）
//
//	T 字元位移 x ──對應段（二分搜尋）──▶ K 字元位移 y ──行表──▶ 頁欄行 + 行內偏置
//
// 對應段的形式是「合併過的首尾相接段」：段內 k = t + (kStart - tStart)，
// 段與段之間才是單邊插文（只有一側前進）。查詢語意與 TypeScript 版完全相同。
package main

import (
	"strconv"
	"strings"
)

// OffsetMap 是位移層的對照結果。
type OffsetMap struct {
	Src    int32  // 輸入側位移（若被移到正文邊界，這裡是移動後的值）
	Dst    int32  // 對側位移
	Exact  bool   // 是否落在 1:1 對應段內
	Adjust string // none / preface / appendix
	Notes  []string
}

// ConvertResult 是一次換算的完整結果。
type ConvertResult struct {
	OK             bool
	Input          string
	Koryo          string // 高麗藏位址
	AdjustedTaisho string // 修正後的大正藏位址
	TPcl, KPcl     string
	TOff, KOff     int
	TSutra, KSutra string
	TJuan, KJuan   int
	Adjust         string
	Exact          bool
	Note           string
}

// ---------------------------------------------------------------- 基本查詢

// findLine 找出 seq 所在（或最接近）的行號，第二個回傳值表示是否精確命中。
func findLine(g *SideGeom, seq int32) (int, bool) {
	n := len(g.LineSeq)
	if n == 0 {
		return 0, false
	}
	lo, hi, ans := 0, n-1, 0
	for lo <= hi {
		mid := (lo + hi) / 2
		if g.LineSeq[mid] <= seq {
			ans, lo = mid, mid+1
		} else {
			hi = mid - 1
		}
	}
	if g.LineSeq[ans] == seq {
		return ans, true
	}
	if ans+1 < n && abs32(g.LineSeq[ans+1]-seq) < abs32(g.LineSeq[ans]-seq) {
		return ans + 1, false
	}
	return ans, false
}

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

// lineIndexAt 找出字元位移落在哪一行（空行會被跳過，落在下一個有字的行）。
func lineIndexAt(g *SideGeom, off int32) int {
	n := len(g.LineStart) - 1
	if n <= 0 {
		return 0
	}
	lo, hi, ans := 0, n-1, 0
	for lo <= hi {
		mid := (lo + hi) / 2
		if g.LineStart[mid] <= off {
			ans, lo = mid, mid+1
		} else {
			hi = mid - 1
		}
	}
	return ans
}

// mapOffset 由 T 位移查 K 位移；落在單邊插文時取最接近的左界。
func mapOffset(runs []int32, tOff int32) (int32, bool) {
	n := len(runs) / 3
	if n == 0 {
		return 0, false
	}
	lo, hi, ans := 0, n-1, -1
	for lo <= hi {
		mid := (lo + hi) / 2
		if runs[mid*3] <= tOff {
			ans, lo = mid, mid+1
		} else {
			hi = mid - 1
		}
	}
	if ans < 0 {
		return runs[1], false
	}
	t0, k0, l := runs[ans*3], runs[ans*3+1], runs[ans*3+2]
	if tOff < t0+l {
		return k0 + (tOff - t0), true
	}
	return k0 + l, false
}

// mapOffsetRev 由 K 位移反查 T 位移。
func mapOffsetRev(runs []int32, kOff int32) (int32, bool) {
	n := len(runs) / 3
	if n == 0 {
		return 0, false
	}
	lo, hi, ans := 0, n-1, -1
	for lo <= hi {
		mid := (lo + hi) / 2
		if runs[mid*3+1] <= kOff {
			ans, lo = mid, mid+1
		} else {
			hi = mid - 1
		}
	}
	if ans < 0 {
		return runs[0], false
	}
	t0, k0, l := runs[ans*3], runs[ans*3+1], runs[ans*3+2]
	if kOff < k0+l {
		return t0 + (kOff - k0), true
	}
	return t0 + l, false
}

// ---------------------------------------------------------------- 位移對照

// MapTOffset 大正藏字元位移 → 高麗藏字元位移（含序文／附文修正）。
func MapTOffset(rec *AlignRec, x int32) OffsetMap {
	m := OffsetMap{Src: x, Adjust: "none"}
	if x < rec.TBody[0] {
		m.Src, m.Adjust = rec.TBody[0], "preface"
		m.Notes = append(m.Notes, "輸入落在序文，已移到該卷正文第一字")
	} else if x > rec.TBody[1] {
		m.Src, m.Adjust = rec.TBody[1], "appendix"
		m.Notes = append(m.Notes, "輸入落在附文，已移到該卷正文最後一字的右邊")
	}
	y, exact := mapOffset(rec.Runs, m.Src)
	if y < rec.KBody[0] {
		y = rec.KBody[0]
	}
	if y > rec.KBody[1] {
		y = rec.KBody[1]
	}
	m.Dst, m.Exact = y, exact
	if !exact {
		m.Notes = append(m.Notes, "該處是單邊插文，高麗藏無對應字，已取最接近的位置")
	}
	if rec.Coarse {
		m.Notes = append(m.Notes, "本卷對齊粗略，轉換結果僅供參考")
	}
	return m
}

// MapKOffset 高麗藏字元位移 → 大正藏字元位移。
func MapKOffset(rec *AlignRec, y int32) OffsetMap {
	m := OffsetMap{Src: y, Adjust: "none"}
	if y < rec.KBody[0] {
		m.Src, m.Adjust = rec.KBody[0], "preface"
		m.Notes = append(m.Notes, "輸入落在序文，已移到該卷正文第一字")
	} else if y > rec.KBody[1] {
		m.Src, m.Adjust = rec.KBody[1], "appendix"
		m.Notes = append(m.Notes, "輸入落在附文，已移到該卷正文最後一字的右邊")
	}
	x, exact := mapOffsetRev(rec.Runs, m.Src)
	if x < rec.TBody[0] {
		x = rec.TBody[0]
	}
	if x > rec.TBody[1] {
		x = rec.TBody[1]
	}
	m.Dst, m.Exact = x, exact
	if !exact {
		m.Notes = append(m.Notes, "該處是單邊插文，大正藏無對應字，已取最接近的位置")
	}
	if rec.Coarse {
		m.Notes = append(m.Notes, "本卷對齊粗略，轉換結果僅供參考")
	}
	return m
}

// ---------------------------------------------------------------- 位址層

func geomAddress(side Side, g *SideGeom, off int32) Address {
	li := lineIndexAt(g, off)
	page, col, line := PclOfSeq(int(g.LineSeq[li]))
	o := int(off) - int(g.LineStart[li])
	if o < 0 {
		o = 0
	}
	if o > MaxOff {
		o = MaxOff
	}
	return Address{Side: side, Vol: g.Vol, Page: page, Col: col, Line: line, Off: o}
}

type resolved struct {
	li      int
	hit     bool
	pcl     string
	charOff int32
}

func resolveInput(g *SideGeom, page, col, line, off int) resolved {
	pcl := FormatPcl(page, col, line)
	seq := SeqOf(page, col, line)
	li, hit := findLine(g, int32(seq))
	lineHan := g.LineStart[li+1] - g.LineStart[li]
	o := off
	if o < 0 {
		o = 0
	}
	if int32(o) > lineHan {
		o = int(lineHan)
	}
	return resolved{li: li, hit: hit, pcl: pcl, charOff: g.LineStart[li] + int32(o)}
}

func resultOf(rec *AlignRec, input string, srcSide Side, src *SideGeom, dstSide Side, dst *SideGeom, m OffsetMap, extra []string) ConvertResult {
	sa := geomAddress(srcSide, src, m.Src)
	da := geomAddress(dstSide, dst, m.Dst)
	ta, ka := sa, da
	if srcSide == SideK {
		ta, ka = da, sa
	}
	adjust := m.Adjust
	if adjust == "none" && len(extra) > 0 {
		adjust = "nearest-line"
	}
	notes := append(append([]string{}, extra...), m.Notes...)
	return ConvertResult{
		OK:             true,
		Input:          input,
		Koryo:          ka.String(),
		AdjustedTaisho: ta.String(),
		TPcl:           FormatPcl(ta.Page, ta.Col, ta.Line),
		KPcl:           FormatPcl(ka.Page, ka.Col, ka.Line),
		TOff:           ta.Off,
		KOff:           ka.Off,
		TSutra:         rec.TSutra, TJuan: rec.TJuan,
		KSutra: rec.KSutra, KJuan: rec.KJuan,
		Adjust: adjust,
		Exact:  m.Exact,
		Note:   strings.Join(notes, "；"),
	}
}

func failedResult(rec *AlignRec, input, note string) ConvertResult {
	return ConvertResult{
		Input: input, TSutra: rec.TSutra, TJuan: rec.TJuan,
		KSutra: rec.KSutra, KJuan: rec.KJuan, Adjust: "none", Note: note,
	}
}

// annotateEmptyLine 輸入那一行若整行沒有漢字，指針其實落在下一個有字的行，必須講清楚。
func annotateEmptyLine(res ConvertResult, side Side, g *SideGeom, charOff int32, inPcl string) ConvertResult {
	if !res.OK {
		return res
	}
	landed := FormatPcl(PclOfSeq(int(g.LineSeq[lineIndexAt(g, charOff)])))
	if landed == inPcl {
		return res
	}
	who := "大正藏"
	if side == SideK {
		who = "高麗藏"
	}
	note := who + " " + inPcl + " 整行沒有漢字，指針已移到最近的有字行 " + landed
	if res.Adjust == "none" {
		res.Adjust = "empty-line"
	}
	if res.Note != "" {
		res.Note = note + "；" + res.Note
	} else {
		res.Note = note
	}
	return res
}

// ConvertTaishoGoryeo 輸入大正藏位址，回傳高麗藏位址與修正後的大正藏位址。
//
//	輸入指向序文 → 移到該卷正文第一字；指向附文 → 移到該卷正文最後一字的右邊。
func ConvertTaishoGoryeo(rec *AlignRec, addr string) ConvertResult {
	a, ok := ParseAddress(addr)
	if !ok {
		return failedResult(rec, addr, "位址無法解析")
	}
	if a.Side != SideT {
		return failedResult(rec, addr, "輸入必須是大正藏位址（T 開頭）")
	}
	if a.Vol != rec.T.Vol {
		return failedResult(rec, addr, "冊號不符：輸入第 "+strconv.Itoa(a.Vol)+" 冊，該卷在第 "+strconv.Itoa(rec.T.Vol)+" 冊")
	}
	if len(rec.T.LineSeq) == 0 {
		return failedResult(rec, addr, "大正藏該卷沒有資料")
	}
	inp := resolveInput(&rec.T, a.Page, a.Col, a.Line, a.Off)
	var extra []string
	if !inp.hit {
		extra = append(extra, "大正藏無 "+inp.pcl+" 此行，已取最接近的 "+
			FormatPcl(PclOfSeq(int(rec.T.LineSeq[inp.li]))))
	}
	res := resultOf(rec, addr, SideT, &rec.T, SideK, &rec.K, MapTOffset(rec, inp.charOff), extra)
	return annotateEmptyLine(res, SideT, &rec.T, inp.charOff, inp.pcl)
}

// ConvertGoryeoTaisho 反向：高麗藏位址 → 大正藏位址。
func ConvertGoryeoTaisho(rec *AlignRec, addr string) ConvertResult {
	a, ok := ParseAddress(addr)
	if !ok {
		return failedResult(rec, addr, "位址無法解析")
	}
	if a.Side != SideK {
		return failedResult(rec, addr, "輸入必須是高麗藏位址（K 開頭）")
	}
	if a.Vol != rec.K.Vol {
		return failedResult(rec, addr, "冊號不符：輸入第 "+strconv.Itoa(a.Vol)+" 冊，該卷在第 "+strconv.Itoa(rec.K.Vol)+" 冊")
	}
	if len(rec.K.LineSeq) == 0 {
		return failedResult(rec, addr, "高麗藏該卷沒有資料")
	}
	inp := resolveInput(&rec.K, a.Page, a.Col, a.Line, a.Off)
	var extra []string
	if !inp.hit {
		extra = append(extra, "高麗藏無 "+inp.pcl+" 此行，已取最接近的 "+
			FormatPcl(PclOfSeq(int(rec.K.LineSeq[inp.li]))))
	}
	res := resultOf(rec, addr, SideK, &rec.K, SideT, &rec.T, MapKOffset(rec, inp.charOff), extra)
	return annotateEmptyLine(res, SideK, &rec.K, inp.charOff, inp.pcl)
}
