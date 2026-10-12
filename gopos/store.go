// store.go — 把 asset 變成可查詢的索引
//
// 兩種查法：
//  1. 已知經號與卷號：byKey["T0001/1"]
//  2. 只有冊號與頁欄行：byTVol[冊號] 是一串依 tStartSeq 排序的卷索引，二分搜尋
//     （高麗藏方向同理用 byKVol）
//
// 各卷的 blob 採惰性解碼：查到卷之後才解開，解開過的放進快取。
package main

import (
	"fmt"
	"sort"
	"strings"
)

// Store 是可查詢的對照資料。
type Store struct {
	Asset *Asset
	Path  string // 來源檔名（內嵌時為 "(內嵌)"）

	byKey  map[string]int
	byTVol map[int][]int
	byKVol map[int][]int

	cache map[int]*AlignRec
}

// NewStore 由 asset 建索引。
func NewStore(a *Asset, path string) *Store {
	s := &Store{
		Asset:  a,
		Path:   path,
		byKey:  make(map[string]int, len(a.Index)),
		byTVol: make(map[int][]int),
		byKVol: make(map[int][]int),
		cache:  make(map[int]*AlignRec),
	}
	for i, r := range a.Index {
		s.byKey[key(r.TSutra, r.TJuan)] = i
		s.byTVol[r.TVol] = append(s.byTVol[r.TVol], i)
		s.byKVol[r.KVol] = append(s.byKVol[r.KVol], i)
	}
	for _, list := range s.byTVol {
		sort.Slice(list, func(x, y int) bool { return a.Index[list[x]].TStartSeq < a.Index[list[y]].TStartSeq })
	}
	for _, list := range s.byKVol {
		sort.Slice(list, func(x, y int) bool { return a.Index[list[x]].KStartSeq < a.Index[list[y]].KStartSeq })
	}
	return s
}

func key(sutra string, juan int) string {
	return sutra + "/" + itoa(juan)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [8]byte
	i := len(b)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		b[i] = '-'
	}
	return string(b[i:])
}

// NormSutra 正規化經號：數字補足 4 位、字母大寫。
func NormSutra(s string) string {
	t := strings.TrimSpace(s)
	i := 0
	for i < len(t) && t[i] >= '0' && t[i] <= '9' {
		i++
	}
	if i == 0 {
		return strings.ToUpper(t)
	}
	digits := t[:i]
	rest := strings.ToUpper(t[i:])
	for len(digits) < 4 {
		digits = "0" + digits
	}
	if len(rest) > 1 {
		rest = rest[:1]
	}
	return digits + rest
}

// Rec 取得某一大正藏卷的對齊資料（解碼後快取）。
func (s *Store) Rec(tsutra string, tjuan int) (*AlignRec, error) {
	i, ok := s.byKey[key(NormSutra(tsutra), tjuan)]
	if !ok {
		return nil, fmt.Errorf("對照資料裡沒有 T%s 卷第 %d 卷", NormSutra(tsutra), tjuan)
	}
	return s.RecAt(i)
}

// RecAt 取得第 i 筆索引的對齊資料。
func (s *Store) RecAt(i int) (*AlignRec, error) {
	if r, ok := s.cache[i]; ok {
		return r, nil
	}
	ir := s.Asset.Index[i]
	body, err := DecodeAlign(s.Asset.Blob(i))
	if err != nil {
		return nil, err
	}
	r := &AlignRec{TSutra: ir.TSutra, KSutra: ir.KSutra, TJuan: ir.TJuan, KJuan: ir.KJuan, AlignBody: body}
	s.cache[i] = r
	return r, nil
}

// FindByTsutra 由「大正藏冊號 + 頁欄行流水號」找卷。
func (s *Store) FindByTsutra(vol, seq int) (int, bool) {
	return findIn(s.byTVol[vol], s.Asset.Index, seq, true)
}

// FindByKsutra 由「高麗藏冊號 + 頁欄行流水號」找卷。
func (s *Store) FindByKsutra(vol, seq int) (int, bool) {
	return findIn(s.byKVol[vol], s.Asset.Index, seq, false)
}

func findIn(list []int, idx []IndexRec, seq int, tSide bool) (int, bool) {
	lo, hi := 0, len(list)-1
	for lo <= hi {
		mid := (lo + hi) / 2
		r := idx[list[mid]]
		start, end := r.KStartSeq, r.KEndSeq
		if tSide {
			start, end = r.TStartSeq, r.TEndSeq
		}
		switch {
		case seq < start:
			hi = mid - 1
		case seq > end:
			lo = mid + 1
		default:
			return list[mid], true
		}
	}
	return 0, false
}

// RecForAddress 由大正藏位址找出所屬的對齊卷。
func (s *Store) RecForAddress(a Address) (*AlignRec, error) {
	i, ok := s.FindByTsutra(a.Vol, SeqOf(a.Page, a.Col, a.Line))
	if !ok {
		return nil, fmt.Errorf("第 %d 冊 %s 在對照資料中找不到", a.Vol,
			FormatPcl(a.Page, a.Col, a.Line))
	}
	return s.RecAt(i)
}

// Stats 回傳簡短的統計字串。
func (s *Store) Stats() string {
	sutras := map[string]bool{}
	juans := 0
	han := 0
	for _, r := range s.Asset.Index {
		sutras[r.TSutra] = true
		juans++
	}
	for i := range s.Asset.Index {
		if rec, err := s.RecAt(i); err == nil {
			han += rec.K.Han
		}
	}
	return fmt.Sprintf("%d 部經 / %d 卷 / 高麗藏 %d 漢字", len(sutras), juans, han)
}
