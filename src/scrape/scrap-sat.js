/* 抓SAT2018 文字 ，很多行會重覆，執行 combinevol.js 合併成不重覆的文字*/
/* 必須先安裝 curl */
const fs=require('fs');
const {readFileSync, writeFileSync } = require('node:fs');
const util = require('node:util');
const baseurl='https://21dzk.l.u-tokyo.ac.jp/SAT2018/satdb2018pre.php?ob=1&mode2=2&mode=detail&nonum=&kaeri=&useid=';

//const startbook=1;
//const endbook=2919; //last book is 2920, do it manually
const startbook=1;
const endbook=2919;
const outdir='raw/';
const extra=['0150A','0150B','0864A','0864B','0924A','0924B','0924C',
'0944A','0944B','0954A','0954B',
'0974A','0974B','0974C','0974D','0974E','0974F',
'0983A','0983B','1005A','1005B','1022A','1022B',
'1027A','1027B','1028A','1028B',
"1045A","1045B", "1057A","1057B", "1062A","1062B", "1072A","1072B", "1108A","1108B", 
"1113A","1113B", "1120A","1120B", "1134A","1134B", "1156A","1156B",
"1159A","1159B", "1168A","1168B", "1177A","1177B", "1185A","1185B", 
"1670A","1670B", "1887A","1887B", "1969A","1969B", "1986A","1986B", "1987A","1987B", "1994A","1994B",  "1998A","1998B", 
"2002A","2002B", "2012A","2012B", "2019A","2019B", "2133A","2133B", "2141A","2141B", "2168A","2168B", "2174A","2174B", 
"2203A","2203B", "2206A","2206B",  "2208A","2208B", "2208C","2307A","2307B", "2358A","2358B", "2395A","2395B", 
"2764A","2764B", "2830A","2830B", "2917A","2917B"
];
const skips=[
  150, 864, 924, 944, 954, 974, 983, 1005, 1022, 1027,
  1028, 1045, 1057, 1062, 1072, 1108, 1113, 1120, 1134, 1156,
  1159, 1168, 1177, 1185, 1670, 1887, 1969, 1986, 1987, 1994,
  1998, 2002, 2012, 2019, 2133, 2141, 2168, 2174, 2203, 2206,
  2208, 2307, 2358, 2395, 2764, 2830, 2917
];

let nextbookfirstpage='';
const last_vpl=content=>{
    const i=content.lastIndexOf('<span class="ln">');
    if (i>=0) {
        const e= content.indexOf('<',i+18);
        return content.slice(i+17,e).replace(': ','');
    }
    return '';
}

const first_vpl=content=>{
    const i=content.indexOf('<span class="ln">');
    if (i>=0) {
        const e= content.indexOf('<',i+17);
        return content.slice(i+17,e).replace(': ','');
    }
    return '';
}
const parseVPL=vpl=>{
    let [m,sutraid,vol,page,col,line]=vpl.match(/T(\d\d\d\d)_\.(\d\d)\.(\d\d\d\d)([abcd])(\d\d)/);

    vol=parseInt(vol,10);
    page=parseInt(page,10);
    line=parseInt(line,10);
    sutraid=parseInt(sutraid,10);
    return [vol,page,col,line,sutraid];
}
const nextline=(vpl)=>{
    let [vol,page,col,line]=parseVPL(vpl);
    if (line>=29) {
        if (col=='c') {
            col='a';
            page++;
        } else {
            if (col=='b') col='c'
            else col='b'
        }
        line=1;
    } else {
        line++;
    }
    let s='';
    s+=vol.toString().padStart(2,'0')+'.'+page.toString().padStart(4,'0')+col+line.toString().padStart(2,'0');
    return s;
}


const previousline=(vpl)=>{
    let [vol,page,col,line]=parseVPL(vpl);
    if (line==1) {
        if (col=='a') {
            if (page==1) {
                console.log('cannot go back to previous vol');
                return ''
            } else {
                page--;
                col='c';
                line=29;
            }
        } else {
            line=29;
            if (col=='b') col='a';
            else if (col=='c') col='b';
        }
    } else {
        line--;
    }
    let s=vol.toString().padStart(2,'0')+'.'+page.toString().padStart(4,'0')+col+line.toString().padStart(2,'0');
    return s;
}
const tidy=content=>{
    const i=content.indexOf('<body>');
    if (i>=0) content= content.slice(i+6);
    content=content.replace(/ style="font-size:8px;padding:2px"/g,'');
    content=content.replace(/<span class="ln">(.+?)<\/span>/g,'\n$1')
    content=content.replace(/<a name="[^"]+?" class="al"><span class="tx">(.+?)<\/span><\/a>/g,'$1');
    content=content.replace(/<br\/>\n/g,'\n');
    return content.replace(/<a class="iiifDrop".+?<\/a>/g,'');
    return content;
}
const pagebypage=async (vol,firstpage)=>{//have to do juan by juan
    const out=[];
    let page=firstpage,prevpage;
    let topvpl=first_vpl(firstpage),prevvpl;
    let bottomvpl=last_vpl(firstpage);
    while (true){
        if (page) {
            if (!fs.existsSync(outdir+'T'+vol))fs.mkdirSync(outdir+'T'+v);
            const outfn=outdir+'T'+vol+'/'+topvpl.replace(/\.\d\d\./,'')+'.html';//remove vol
            if (fs.existsSync(outfn)){
                const written= readFileSync(outfn,'utf8')
                if (written!==tidy(page)){
                    writeFileSync(outfn,tidy(page));
                }
            } else {
                writeFileSync(outfn,tidy(page));
            }
            console.log('wrote',page.length,outfn);
        }
        const nextpagevpl=bottomvpl;
        const fullurl=baseurl+nextpagevpl.slice(1);
        prevpage=page;
        page=await (await fetch(fullurl)).text();
        topvpl=first_vpl(page);
        bottomvpl=last_vpl(page);
        if(page==prevpage) break;
    }
}
const fetchone=async(id)=>{
    let res=await fetch(baseurl+id);
    let page=await res.text();
    return page;
}
const fetchall=async  ()=>{
    let page='';
    for (let i=startbook;i<endbook;i++) { //ignore last book
        if (~skips.indexOf(i)) continue;//skip 大般若經,cross vol

        let res=await fetch(baseurl+i.toString().padStart(4,'0')+'_');
        page=await res.text();

        if (!page) {
            fs.appendFileSync('emptyfile.txt',i.toString()+'\n');
            continue;
        }
        res=await fetch(baseurl+(i+1).toString().padStart(4,'0')+'_');
        nextbookpage=await res.text();
        if (!nextbookpage) {
            console.log('error',baseurl+(i+1).toString().padStart(4,'0')+'_')
            continue;
        }
        const fvpl=first_vpl(nextbookpage);
        
        const last_vpl=previousline( fvpl ,true);
        const vpl=first_vpl(page)
        const v=(parseVPL(vpl)[0].toString().padStart(2,'0'));

        if (!fs.existsSync(outdir+'T'+v))fs.mkdirSync(outdir+'T'+v);

        if (!last_vpl) {//cross volumn, try pagebypage
            await pagebypage(v,page);
            continue;
        }
        

        const fullurl=baseurl+i.toString().padStart(4,'0')+'_'
        +last_vpl;
        let out=await (await fetch(fullurl)).text();
        const outfn=outdir+'T'+v+'/'+vpl.replace(/\.\d\d\./,'')+'.html';//remove vol

        if (~out.indexOf(vpl)&&~out.indexOf(last_vpl)){//已取畢
            out=tidy(out);
            if (fs.existsSync(outfn) && readFileSync(outfn,'utf8')==out) {
            }else{
                writeFileSync(outfn,out);
                console.log('written',out.length,outfn);
            }
        } else { //一頁頁取下來
            await pagebypage(v,page);
        }

    }
}
//fetchall();

const fetch220=async ()=>{
    let page = await fetchone('0220_.05.')
    await pagebypage('05',page);
    page = await fetchone('0220_.06.')
    await pagebypage('06',page);
    page = await fetchone('0220_.07.')
    await pagebypage('07',page);    
}
//fetch220();

const fetchWithAlphabet=async()=>{
    for (let i=0;i<extra.length;i++) {
        let page = await fetchone(extra[i])
        const vol=page.match(/T[\dA-Z]+\.(\d\d)\./)[1];
        await pagebypage(vol,page);
    }
}

//fetchWithAlphabet();
//const missing=["0149","0863","0923","0943","0953","0973","0982","1004","1021","1026","1044","1056","1061","1071","1107","1112","1119","1133","1155","1158","1167","1176","1184","1316","1669","1886","1968","1985","1993","1997","2001","2011","2018","2132","2140","2167","2173","2202","2205","2207","2266","2306","2357","2394","2565","2763","2829","2916","2919","2920"]
const missing=["1168B","1308","1889","1973","2035","2704","2871"]

const fetchMissing=async()=>{
    for (let i=0;i<missing.length;i++) {
        let fn=missing[i];
        if (fn.length==4)fn+='_'
        let page = await fetchone(fn)
        const vol=page.match(/T[\dA-Z_]+\.(\d\d)\./)[1];
        await pagebypage(vol,page);
    }
}
fetchMissing();