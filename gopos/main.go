// poscli — 大正藏 ⇄ 高麗藏 位置轉換（單一執行檔，資料與演算法都在裡面）
//
// 用法：
//
//	poscli T01p0002c0405              換算一個位置（convert 是預設命令）
//	poscli convert T01p0002c0405 ...  換算多個
//	poscli k2t K17p0816b1301          反向：高麗藏 → 大正藏
//	poscli info                       顯示內嵌 asset 的統計
//	poscli unpack -o posmap.raw       把 asset 解成未壓縮的容器
//	poscli pack -o small.pos -codec brotli   重新壓縮（可選 brotli／zstd／gzip／none）
//	poscli -asset other.pos ...       改用外部 asset 檔，不用內嵌的
//	poscli -json T01p0002c0405        以 JSON 一行一筆輸出
//
// asset 檔由 Bun 端的 buildpos.ts --pos <file> 產生（見 posasset.ts 的版面說明）；
// 本程式用 go:embed 把它一起編進執行檔，所以預設不需要任何外部檔案。
package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
)

//go:embed asset/posmap.pos
var embeddedAsset []byte

const (
	embeddedName = "(內嵌)"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func usage() {
	fmt.Print(`poscli — 大正藏 ⇄ 高麗藏 位置轉換

用法：
  poscli T01p0002c0405 [更多位址…]        換算（convert 是預設命令）
  poscli convert T01p0002c0405 …           同上
  poscli k2t K17p0816b1301 …               反向：高麗藏 → 大正藏
  poscli info                              顯示 asset 統計
  poscli unpack -o posmap.raw              解成未壓縮容器
  poscli pack -o out.pos -codec brotli     重新壓縮

選項：
  -asset <檔>   改用外部 asset（預設用編進執行檔的那份）
  -json         以 JSON 輸出
  -codec <名>   pack 用的壓縮方式：none/deflate/gzip/zstd/brotli

位址格式：T01p0002c0405 = 大正藏第 1 冊第 0002 頁 c 欄第 04 行第 05 個字之前；
偏置為 0 可省略；偏置 ≥ 100 的長行寫成 T49p0024a17.118。
`)
}

func run(args []string) int {
	assetPath := ""
	jsonOut := false
	codecName := "brotli"
	outPath := ""
	var rest []string

	for i := 0; i < len(args); i++ {
		a := args[i]
		next := func() string {
			if i+1 < len(args) {
				i++
				return args[i]
			}
			return ""
		}
		switch {
		case a == "-h" || a == "--help" || a == "help":
			usage()
			return 0
		case a == "-asset" || a == "--asset":
			assetPath = next()
		case strings.HasPrefix(a, "-asset="):
			assetPath = strings.TrimPrefix(a, "-asset=")
		case a == "-json" || a == "--json":
			jsonOut = true
		case a == "-codec" || a == "--codec":
			codecName = next()
		case strings.HasPrefix(a, "-codec="):
			codecName = strings.TrimPrefix(a, "-codec=")
		case a == "-o" || a == "--out":
			outPath = next()
		case strings.HasPrefix(a, "-o="):
			outPath = strings.TrimPrefix(a, "-o=")
		default:
			rest = append(rest, a)
		}
	}

	var store *Store
	load := func() (*Store, int) {
		if store != nil {
			return store, 0
		}
		var as *Asset
		var err error
		if assetPath != "" {
			as, err = ReadAssetFile(assetPath)
			if err != nil {
				fmt.Fprintf(os.Stderr, "讀取 asset 失敗：%v\n", err)
				return nil, 1
			}
			store = NewStore(as, assetPath)
		} else {
			as, err = ParseAsset(embeddedAsset)
			if err != nil {
				fmt.Fprintf(os.Stderr, "解開內嵌 asset 失敗：%v\n", err)
				return nil, 1
			}
			store = NewStore(as, embeddedName)
		}
		return store, 0
	}

	cmd := "convert"
	if len(rest) > 0 {
		switch rest[0] {
		case "convert", "k2t", "info", "unpack", "pack", "verify", "version":
			cmd = rest[0]
			rest = rest[1:]
		}
	}

	switch cmd {
	case "version":
		fmt.Println("poscli 1.0（asset 格式 2）")
		return 0

	case "info":
		st, rc := load()
		if st == nil {
			return rc
		}
		a := st.Asset
		fmt.Printf("asset      %s\n", st.Path)
		fmt.Printf("格式       版本 2、codec %s、payload %.2f MB、壓縮後 %.2f MB、CRC32 %08x\n",
			a.Codec, float64(a.RawLen)/1048576, float64(a.CompLen)/1048576, a.CRC)
		fmt.Printf("收錄       %s\n", st.Stats())
		if len(a.Index) > 0 {
			r := a.Index[0]
			fmt.Printf("首卷       T%s/%d ⇄ K%s/%d（大正第 %d 冊、高麗第 %d 冊）\n",
				r.TSutra, r.TJuan, r.KSutra, r.KJuan, r.TVol, r.KVol)
		}
		return 0

	case "verify":
		st, rc := load()
		if st == nil {
			return rc
		}
		if len(rest) == 0 {
			fmt.Fprintln(os.Stderr, "verify 需要一個測資 TSV（由 bun posconvert.ts --emit-cases <檔> 產生）")
			return 2
		}
		return verifyTSV(st, rest[0])

	case "unpack":
		st, rc := load()
		if st == nil {
			return rc
		}
		if outPath == "" {
			fmt.Fprintln(os.Stderr, "unpack 需要 -o <檔名>")
			return 2
		}
		// 以「不壓縮」重寫，等於把 payload 原樣倒出
		n, err := WriteAssetFile(outPath, st.Asset.payload, CodecNone)
		if err != nil {
			fmt.Fprintf(os.Stderr, "寫檔失敗：%v\n", err)
			return 1
		}
		fmt.Printf("已寫出 %s（%d bytes，未壓縮）\n", outPath, n)
		return 0

	case "pack":
		st, rc := load()
		if st == nil {
			return rc
		}
		if outPath == "" {
			fmt.Fprintln(os.Stderr, "pack 需要 -o <檔名>")
			return 2
		}
		c, err := ParseCodec(codecName)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		n, err := WriteAssetFile(outPath, st.Asset.payload, c)
		if err != nil {
			fmt.Fprintf(os.Stderr, "打包失敗：%v\n", err)
			return 1
		}
		fmt.Printf("已寫出 %s（codec %s，%d bytes，壓縮率 %.1f%%）\n",
			outPath, c, n, 100*float64(n)/float64(st.Asset.RawLen+assetHeaderSize))
		if _, err := ReadAssetFile(outPath); err != nil {
			fmt.Fprintf(os.Stderr, "警告：寫出的檔案讀不回來：%v\n", err)
			return 1
		}
		fmt.Println("已重新讀回驗證，CRC 通過")
		return 0
	}

	if len(rest) == 0 {
		usage()
		return 2
	}
	st, rc := load()
	if st == nil {
		return rc
	}

	bad := 0
	for _, arg := range rest {
		var res ConvertResult
		a, ok := ParseAddress(arg)
		if !ok {
			fmt.Printf("✗ %s：位址無法解析\n", arg)
			bad++
			continue
		}
		if cmd == "k2t" {
			if a.Side != SideK {
				fmt.Printf("✗ %s：k2t 需要高麗藏位址（K 開頭）\n", arg)
				bad++
				continue
			}
			i, ok := st.FindByKsutra(a.Vol, SeqOf(a.Page, a.Col, a.Line))
			if !ok {
				fmt.Printf("✗ %s：第 %d 冊此頁在對照資料中找不到\n", arg, a.Vol)
				bad++
				continue
			}
			rec, err := st.RecAt(i)
			if err != nil {
				fmt.Printf("✗ %s：%v\n", arg, err)
				bad++
				continue
			}
			res = ConvertGoryeoTaisho(rec, arg)
		} else {
			if a.Side != SideT {
				fmt.Printf("✗ %s：請輸入大正藏位址（T 開頭），反向請用 k2t\n", arg)
				bad++
				continue
			}
			rec, err := st.RecForAddress(a)
			if err != nil {
				fmt.Printf("✗ %s：%v\n", arg, err)
				bad++
				continue
			}
			res = ConvertTaishoGoryeo(rec, arg)
		}
		if !res.OK {
			fmt.Printf("✗ %s：%s\n", arg, res.Note)
			bad++
			continue
		}
		if jsonOut {
			b, _ := json.Marshal(map[string]any{
				"input": res.Input, "koryo": res.Koryo, "adjustedTaisho": res.AdjustedTaisho,
				"tPcl": res.TPcl, "kPcl": res.KPcl, "tOff": res.TOff, "kOff": res.KOff,
				"tsutra": res.TSutra, "tjuan": res.TJuan, "ksutra": res.KSutra, "kjuan": res.KJuan,
				"adjust": res.Adjust, "exact": res.Exact, "note": res.Note,
			})
			fmt.Println(string(b))
			continue
		}
		fmt.Printf("輸入        %s\n", res.Input)
		fmt.Printf("高麗藏      %s\n", res.Koryo)
		fmt.Printf("修正後大正  %s\n", res.AdjustedTaisho)
		fmt.Printf("經卷        T%s 卷 %d  ⇄  K%s 卷 %d\n", res.TSutra, res.TJuan, res.KSutra, res.KJuan)
		fmt.Printf("對照        %s 第 %d 字  →  %s 第 %d 字", res.TPcl, res.TOff, res.KPcl, res.KOff)
		if res.Exact {
			fmt.Print("（精確對應）")
		} else {
			fmt.Print("（落在單邊插文）")
		}
		fmt.Println()
		if res.Adjust != "none" {
			fmt.Printf("調整        %s\n", res.Adjust)
		}
		if res.Note != "" {
			fmt.Printf("備註        %s\n", res.Note)
		}
		fmt.Println()
	}
	if bad > 0 {
		return 1
	}
	_ = strconv.Itoa
	return 0
}
