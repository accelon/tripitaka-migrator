// verify.go — 跨實作對帳：拿 Bun 版（posconvert.ts --emit-cases）產生的測資，
// 用 Go 版重算一遍，逐欄位比對。這是「兩份實作真的算出同一件事」的證據。
//
//	poscli verify cases.tsv
//
// TSV 欄位：方向 輸入 高麗藏 修正後大正 頁欄行T 偏置T 頁欄行K 偏置K 調整 精確 備註
package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func verifyTSV(st *Store, path string) int {
	f, err := os.Open(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "開檔失敗：%v\n", err)
		return 1
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	head := true
	total, t2k, k2t, bad, line := 0, 0, 0, 0, 0
	shown := 0
	fieldBad := map[string]int{}

	for sc.Scan() {
		line++
		text := strings.TrimRight(sc.Text(), "\r")
		if head {
			head = false
			if strings.HasPrefix(text, "dir\t") {
				continue
			}
		}
		if text == "" {
			continue
		}
		c := strings.Split(text, "\t")
		if len(c) != 11 {
			fmt.Fprintf(os.Stderr, "第 %d 行欄位數 %d ≠ 11，跳過\n", line, len(c))
			bad++
			continue
		}
		dir, in := c[0], c[1]
		expectMiss := strings.HasSuffix(dir, "-miss")
		baseDir := strings.TrimSuffix(dir, "-miss")
		total++
		if baseDir == "k2t" {
			k2t++
		} else {
			t2k++
		}

		a, ok := ParseAddress(in)
		if !ok {
			// 輸入本身就不合法：兩邊都應該失敗
			continue
		}
		var res ConvertResult
		if baseDir == "k2t" {
			i, found := st.FindByKsutra(a.Vol, SeqOf(a.Page, a.Col, a.Line))
			if !found {
				if !expectMiss {
					bad++
					fieldBad["定位"]++
					if shown < 20 {
						fmt.Printf("✗ %s %s：Go 找不到這一卷，Bun 找到 %s\n", baseDir, in, c[2])
						shown++
					}
				}
				continue
			}
			if expectMiss {
				bad++
				fieldBad["定位(應找不到卻找到)"]++
				if shown < 20 {
					fmt.Printf("✗ %s %s：Go 找到了，Bun 說找不到\n", baseDir, in)
					shown++
				}
				continue
			}
			rec, err := st.RecAt(i)
			if err != nil {
				fmt.Fprintf(os.Stderr, "第 %d 行：%v\n", line, err)
				bad++
				continue
			}
			res = ConvertGoryeoTaisho(rec, in)
		} else {
			i, found := st.FindByTsutra(a.Vol, SeqOf(a.Page, a.Col, a.Line))
			if !found {
				if !expectMiss {
					bad++
					fieldBad["定位"]++
					if shown < 20 {
						fmt.Printf("✗ %s %s：Go 找不到這一卷，Bun 找到 %s\n", baseDir, in, c[2])
						shown++
					}
				}
				continue
			}
			if expectMiss {
				bad++
				fieldBad["定位(應找不到卻找到)"]++
				if shown < 20 {
					fmt.Printf("✗ %s %s：Go 找到了，Bun 說找不到\n", baseDir, in)
					shown++
				}
				continue
			}
			rec, err := st.RecAt(i)
			if err != nil {
				fmt.Fprintf(os.Stderr, "第 %d 行：%v\n", line, err)
				bad++
				continue
			}
			res = ConvertTaishoGoryeo(rec, in)
		}

		got := []string{
			res.Koryo, res.AdjustedTaisho, res.TPcl, strconv.Itoa(res.TOff),
			res.KPcl, strconv.Itoa(res.KOff), res.Adjust, boolStr(res.Exact), res.Note,
		}
		want := c[2:]
		if !res.OK {
			got = []string{"", "", "", "", "", "", "", "", res.Note}
		}
		names := []string{"高麗藏", "修正後大正", "tPcl", "tOff", "kPcl", "kOff", "adjust", "exact", "note"}
		mismatch := false
		for i := range names {
			if got[i] != want[i] {
				mismatch = true
				if !res.OK {
					break
				}
				fieldBad[names[i]]++
			}
		}
		if mismatch {
			bad++
			if shown < 20 {
				fmt.Printf("✗ %s %s\n", dir, in)
				for i := range names {
					if got[i] != want[i] {
						fmt.Printf("    %-12s Go=%q  Bun=%q\n", names[i], got[i], want[i])
					}
				}
				shown++
			}
		}
	}
	if err := sc.Err(); err != nil {
		fmt.Fprintf(os.Stderr, "讀檔失敗：%v\n", err)
		return 1
	}

	fmt.Printf("\n=== 跨實作對帳（Go vs Bun）===\n")
	fmt.Printf("測資        %s\n", path)
	fmt.Printf("asset       %s（%s）\n", st.Path, st.Stats())
	fmt.Printf("比對筆數    %d（T→K %d、K→T %d）\n", total, t2k, k2t)
	fmt.Printf("不符        %d\n", bad)
	if len(fieldBad) > 0 {
		fmt.Printf("不符欄位    ")
		for k, v := range fieldBad {
			fmt.Printf("%s=%d ", k, v)
		}
		fmt.Println()
	}
	if bad == 0 {
		fmt.Println("\n✓ Go 版與 Bun 版逐欄完全一致")
		return 0
	}
	fmt.Println("\n✗ 有差異")
	return 1
}

func boolStr(b bool) string {
	if b {
		return "1"
	}
	return "0"
}
