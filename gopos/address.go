// address.go — 頁欄行位址的解析與格式化
//
// 與 posfmt.ts 同一套規則：
//
//	T01p0002c0405   大正藏 第 1 冊 第 0002 頁 c 欄 第 04 行 第 05 個字之前
//	K17p0815a0301   高麗藏 第 17 冊 第 0815 頁 a 欄 第 03 行 第 01 個字之前
//	T01p0002c04     偏置為 0 時可省略
//	T49p0024a17.118 偏置 ≥ 100 的長行，用點號接三位數
//
// 行號固定取欄號後的前兩位數字，其餘為偏置（故 c405 是行 40 偏置 5）。
package main

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Side 表示是哪一藏。
type Side byte

const (
	SideT Side = 'T'
	SideK Side = 'K'
)

const colLetters = "abcdefg"

// MaxLine / MaxOff 是行號與行內偏置的上限（全庫實測行號最大 92、偏置最大 190）。
const (
	MaxLine = 99
	MaxOff  = 999
)

// Address 是一個頁欄行位址。
type Address struct {
	Side Side
	Vol  int
	Page int
	Col  int // 0..6 對應 a..g
	Line int // 1..99
	Off  int // 0..999，行內第幾個漢字之前
}

var addrRe = regexp.MustCompile(`^\s*([KTkt])\s*(\d{1,4})\s*p\s*(\d{1,4})\s*([a-gA-G])\s*(\d{1,4})\s*(?:\.\s*(\d{1,3}))?\s*$`)

// ParseAddress 解析位址字串，失敗回傳 false。
func ParseAddress(s string) (Address, bool) {
	m := addrRe.FindStringSubmatch(s)
	if m == nil {
		return Address{}, false
	}
	digits := m[5]
	var line, off int
	switch {
	case m[6] != "":
		line, _ = strconv.Atoi(digits)
		off, _ = strconv.Atoi(m[6])
	case len(digits) <= 2:
		line, _ = strconv.Atoi(digits)
	default:
		line, _ = strconv.Atoi(digits[:2])
		off, _ = strconv.Atoi(digits[2:])
	}
	a := Address{
		Side: Side(strings.ToUpper(m[1])[0]),
		Vol:  atoi(m[2]),
		Page: atoi(m[3]),
		Col:  int(strings.ToLower(m[4])[0] - 'a'),
		Line: line,
		Off:  off,
	}
	if a.Vol < 1 || a.Page > 9999 || a.Col < 0 || a.Col > 6 {
		return Address{}, false
	}
	if a.Line < 0 || a.Line > MaxLine || off < 0 || off > MaxOff {
		return Address{}, false
	}
	return a, true
}

func atoi(s string) int { n, _ := strconv.Atoi(s); return n }

// String 依行業慣例格式化；偏置 0 一律印滿兩位。
func (a Address) String() string {
	line := fmt.Sprintf("%02d", a.Line)
	var tail string
	switch {
	case a.Off >= 100:
		tail = fmt.Sprintf("%s.%03d", line, a.Off)
	default:
		tail = line + fmt.Sprintf("%02d", a.Off)
	}
	col := byte('?')
	if a.Col >= 0 && a.Col < len(colLetters) {
		col = colLetters[a.Col]
	}
	return fmt.Sprintf("%c%02dp%04d%c%s", a.Side, a.Vol, a.Page, col, tail)
}

// SeqOf 是同一冊內可比較大小的流水號。
func SeqOf(page, col, line int) int { return page*1000 + col*100 + line }

// PclOfSeq 由流水號還原頁欄行。
func PclOfSeq(seq int) (page, col, line int) {
	rem := seq % 1000
	return (seq - rem) / 1000, rem / 100, rem % 100
}

// FormatPcl 輸出 5 字元的頁欄行碼。
func FormatPcl(page, col, line int) string {
	c := byte('?')
	if col >= 0 && col < len(colLetters) {
		c = colLetters[col]
	}
	return fmt.Sprintf("%04d%c%02d", page, c, line)
}
