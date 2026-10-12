/* scrap 高麗大藏經標點文字，去除韓文翻譯，冊頁欄行 行首標記，每一經一文件 */
/* 必須先安裝 curl */
/* bun scrap [startsutraid] [processbookcount= all] */
const fs=require('fs');
const { writeFileSync } = require('node:fs');
const util = require('node:util');
const exec = util.promisify(require('node:child_process').exec);

const baseurl='https://kabc.dongguk.edu/viewer/ajaxText?dataId=ABC_IT_K';
const mulu=fs.readFileSync('mulu.tsv','utf8').split(/\r?\n/).map(it=>it.split('\t'))
    .filter(it=>!~it[0].indexOf('-'));//不要次經名

let startbook=6 ;//起始mulu行號 
let endbook=mulu.length-1;//結束書號 ，最後一本不是經文
const skiponejuanbook=true;//跳過一卷的經
//let endbook=14;
const emptypages={6:[1026]};//空頁，避免跳下一卷
const emptycol={'0570':['464b']} //網站缺了
//只產生一部經
let onebook = process.argv[2];
if (onebook && (onebook.length==4 || (onebook.length==5&&onebook.match(/[abcd]$/)))) {
    for (let i=0;i<mulu.length;i++) {
        if (mulu[i][0]==onebook) {
            console.log('start from book index',i)
            startbook=i;
            if (process.argv[3]) endbook=startbook+ (parseInt(process.argv[3])||1);
            break;
        }
    }
}
console.log('start',startbook,'end',endbook)
function tidy (content) {
    let start=content.indexOf('<div class="xsl_body" data-xsl-modepk=');
    start=content.indexOf('>',start)+1
    let end=content.indexOf('</div>',start+1);
    const ori=content.substring(start,end).trim();

    let trans='';
    start=content.indexOf('<div class="xsl_body" data-xsl-modepk=',end);
    if (start>-1){
        end=content.indexOf('</div>',start+1);
        trans=content.substring(start,end).trim();

    }
    return ori+ (trans?("<TRANS>"+trans+"</TRANS>"):'');

}
function isEmptyContent(content){
    const t=tidy(content.trim()).replace(/<.+?>/g,'').replace(/[\t\r\n ]/g,'');
    if (t.length&&t.length<50) console.log(t.length,t);
    return !t;
}

async function scrap(baseurl,sutraid,juan,vol,page,col){
    if (sutraid=='0001b') juan+=150;
    if (sutraid=='0001c') juan+=300;
    if (sutraid=='0001d') juan+=450;
    if (sutraid=='0648b') juan+=25; //中阿含 17後半，18冊
    if (sutraid=='0952b') juan+=170;// 阿毗達磨大毗婆沙論 跨冊

    sutraid=sutraid.replace(/[bcd]$/g,'');
    const volpage=vol.toString().padStart(3,'0')+'_'+page.toString().padStart(4,'0');
    const url=baseurl+sutraid+'_T_'+juan.toString().padStart(3,'0')
        +'&imgId='+volpage+"_"+col;
    
    let t=null,tried=0;
    while (!t){
        try {
            t=((await exec('curl --insecure "'+url+'"')).stdout)
        } catch(e) {
            console.log('tried',++tried,'error',e);
        }
    }
    // process.stdout.write('\r'+url+'  '+t.length+'   '+isEmptyContent(t)+ '  ')
    console.log(url+'   '+t.length+'   '+isEmptyContent(t))
    // t=t.replace(/<span data-jusok-type="원주" data-xsl-tag="주석">(.+?)<\/span>/g,'〈$1〉')
    // .replace(/<.+?>/g,'');
    return t;

}
const isEmptycol=(sutraid,page,col)=>{
    if (!emptycol[sutraid])return false;
    return (~emptycol[sutraid].indexOf(page+col));
}
const endofpage=(sutraid,pageend)=>{
    if (sutraid=='0001') pageend=1253  //v1
    if (sutraid=='0001b') pageend=1215
    if (sutraid=='0001c') pageend=1259
    if (sutraid=='0001d') pageend=1286
    if (sutraid=='0001d') pageend=1286
    if (sutraid=='0021') pageend= 1037//v5
    if (sutraid=='0055') pageend= 1386//v6
    if (sutraid=='0078') pageend=1283 //v7
    if (sutraid=='0104') pageend=1340 //v8

    if (sutraid=='0129') pageend=1445 //v9
    if (sutraid=='0180') pageend=1398 //v10
    if (sutraid=='0333') pageend=1341 //v11

    if (sutraid=='0396') pageend=1409 //v12
    if (sutraid=='0499') pageend=1327 //v13

    if (sutraid=='0549') pageend=1498 //大智度論  //v14
    if (sutraid=='0570') pageend=1342//瑜伽師地論//v15
    if (sutraid=='0592') pageend=1312// 攝大乘論本 , v16 end
    if (sutraid=='0647') pageend=1024// 佛說長阿含經 //v17
    
    if (sutraid=='0648') pageend=1269// 中阿含part1

    if (sutraid=='0650') pageend=1217 //v18
    if (sutraid=='0800') pageend=1032//vol 19 end
    if (sutraid=='0888') pageend=1262//vol 20
    if (sutraid=='0890') pageend=1173//vol 21
    if (sutraid=='0895') pageend=1261 //vol22
    if (sutraid=='0933') pageend=1161 //v23
    if (sutraid=='0946') pageend=1316 //阿毗達磨集異門足論 v24
    if (sutraid=='0951') pageend=996 //阿毗曇毗婆沙論 v25
    if (sutraid=='0952') pageend=1265//阿毗達磨大毗婆沙論 v26
    if (sutraid=='0956') pageend=1355 //v27
    if (sutraid=='0968') pageend=1102  //v28
    if (sutraid=='0986') pageend=1240  //v29
    if (sutraid=='1051') pageend=1292  //v30
    if (sutraid=='1062') pageend=1277 //開元釋教錄
    if (sutraid=='1075') pageend=1274 //續高僧傳 v32
    if (sutraid=='1154') pageend=1243 //佛說聖寶藏神儀軌經 v33
    //1257 cross book
    if (sutraid=='1261') pageend=1023 //御製緣識   v35     
    if (sutraid=='1338') pageend=1123 //   v36 
    if (sutraid=='1397') pageend=1078 // 釋摩訶衍論 v37
    if (sutraid=='1403') pageend=1082 // 大般涅槃經 v38
    if (sutraid=='1406') pageend=1328 //法苑珠林        v39 	
    if (sutraid=='1476') pageend=961 //宗鏡錄 v40
//    if (sutraid=='1497') pageend=//
    if (sutraid=='1499') pageend=538 //宗鏡錄 v44
    if (sutraid=='1504') pageend=628 //大藏一覽集 v45
    if (sutraid=='1505') pageend=507 //禪門拈頌集 v46

    return pageend;
}

const fetchhtml=async  ()=>{
    for (let i=startbook;i<endbook;i++) { //ignore last book
        let [sutraid,taisho,title,vol,juancount,dyn,author,pagestart] = mulu[i];
        const outfilename='html/'+sutraid;
        if (fs.existsSync(outfilename+'.html')) {
            console.log('file exists, skip',outfilename+'.html');
            continue;
        }

        juancount=parseInt(juancount)||1;

        if (skiponejuanbook&&juancount==1) continue;

        if (sutraid.startsWith('!')) continue;//skip K1498
        pagestart=parseInt(pagestart);
        let pageend=parseInt(mulu[i+1][7]);
        pageend=endofpage(sutraid,pageend);
        if (pageend<pagestart) pageend=pagestart+100;//假設一冊最後一經不超過100頁 , vol 46
        const out=[];

        let page=pagestart;
        let juan=1;
        let juanpagecount=0;
        out.push('^j'+juan);
        const emitText=(t,skipaddjuan,col)=>{
            if (!isEmptyContent(t)) {
                out.push(tidy(t))
                juanpagecount++;
            } else {
                console.log('empty',juanpagecount,'juan',juan,'page',page,'pagestart',pagestart,skipaddjuan,isEmptycol(sutraid,page,col))
                if (juan<juancount){
                    if (!skipaddjuan && !isEmptycol(sutraid,page,col)&&juanpagecount>5) {
                        //prevent switch to next juan, for sutra 890, juan 47 to 48
                        if (!out.length) {
                            console.log('empty juan',sutraid,'juan',juan);
                            process.exit();
                        }
                        // writeFileSync(outfilename+'-'+juan+'.html',out.join('\n'),'utf8');
                        // out.length=0;
                        juan++;
                        juanpagecount=0;
                        out.push('^j'+juan);
                        return true;//retry next juan
                    }
                }  else {
                    return false;
                }
                return true;//retry 
            }
        }
        while (page<=pageend) {
            let a=await scrap(baseurl,sutraid,juan,vol,page,'a');
            if (emitText(a,page==pagestart,'a')&&juan<=juancount) {
                a=await scrap(baseurl,sutraid,juan,vol,page,'a');
                emitText(a,true,'a');
            }

            let b=await scrap(baseurl,sutraid,juan,vol,page,'b');
            if (emitText(b,page==pagestart,'b')&&juan<=juancount) {
                b=await scrap(baseurl,sutraid,juan,vol,page,'b');
                emitText(b,true,'b');
            }

            if(sutraid!=='1505'&&sutraid!=='1511'&&sutraid!=='1500'){//only two col
                let c=await scrap(baseurl,sutraid,juan,vol,page,'c');
                if (emitText(c,false,'c')&&juan<=juancount) {
                    c=await scrap(baseurl,sutraid,juan,vol,page,'c');
                    emitText(c,true,'c');
                }
            }

            if ((emptypages[parseInt(vol)]||[]).indexOf(page)>-1) {//跳過空頁
                page++;
            }
            page++
        }
        writeFileSync(outfilename+'.html',out.join('\n'),'utf8');
        out.length=0;
    }
}
fetchhtml();