/* output text with vol-page-col-line */
import {readTextContent, nodefs,filesFromPattern, writeChanged} from 'ptk/nodebundle.cjs'
await nodefs;
const srcdir='html/';
const files=filesFromPattern('*.html',srcdir)
const outdir='txt/'; //by vol
const juaninfo=["經號\t冊號\t經名\t卷號\t起點\t終點\t總行數"];//從 html 抽出 ^j 
const volcontent=[];
// const files=['0001a.html']
let prevpcl='',prevjuan=0,sutraid='',linecount=0,prevvol='01';
const emitvol=()=>{
    writeChanged(outdir+'K'+prevvol+'.tsv', volcontent.join('\n'));
    process.stdout.write('\nWriting volumn '+prevvol+'   ');
    volcontent.length=0;
}

const doline=lines=>{
    let start=0,prevpg,prevcol,prevln,juanstart='',juanstartline='';

    const emitjuaninfo=()=>{
            juanstartline=juanstartline.replace(/\^[a-z]+\d*/g,'')
            if (sutraid.match(/[abcd]$/)) {
                if (sutraid=='0001a') sutraid='0001';
                if (sutraid=='0001b') prevjuan=prevjuan+150;
                if (sutraid=='0001c') prevjuan=prevjuan+300;
                if (sutraid=='0001d') prevjuan=prevjuan+450;
                if (sutraid=='0648b') prevjuan=prevjuan+25;
                if (sutraid=='0952b') prevjuan=prevjuan+170;
            }
            juaninfo.push(sutraid.replace(/[abcd]$/,'')+'\t'+prevvol+'\t'+juanstartline+'\t'+prevjuan+'\t'+ juanstart+'\t'+prevpg+prevcol+prevln+'\t'+linecount)
            linecount=0;
    }
    if (lines[0]=='^j1') {
        prevjuan=1;
        juanstart=(lines[1].split('\t')[0]).substr(3);//get the first pcl
        juanstartline=lines[1].split('\t')[1];
        if (!juanstartline) {//有時有一空行。如 經號 0014
            juanstartline=lines[2].split('\t')[1];
        }
        start++
    }
    for (let i=start;i<lines.length;i++){
        let [pcl,content]=lines[i].split('\t');
        if (!pcl) {
            console.log('line',i,lines[i])
            process.exit(1)
        }
        linecount++;
        const [m,v,pg,col,ln]=pcl.match(/(\d+)p(\d+)([abcd])(\d+)/);
        let juan=0;
        content=content.replace(/\^j(\d+)/,(m,j)=>{
            juan=parseInt(j);
        })
        if (juan) {
            emitjuaninfo();
            if (i<lines.length-1) {
                juanstart=(lines[i+1].split('\t')[0]).substr(3);//get the first pcl
                juanstartline=lines[i+1].split('\t')[1];
                if (!juanstartline) {//有時有一空行。如 經號 0014
                    juanstartline=lines[i+2].split('\t')[1];
                }

                prevjuan=juan;
            } else {
                console.log('has ending ^j at the end, ignore',sutraid)
                prevjuan=0;
            }
        }
        prevpcl=pcl;
        prevpg=pg;
        prevcol=col;
        prevln=ln;
    }
    if (prevjuan) {
        emitjuaninfo();
    }
}
const dofile=fn=>{
    let content=readTextContent(srcdir+fn);
    fn=fn.replace('-','');//這部經正在下載，用舊版的
    content=content.replace(/\n/g,'').replace(/<TRANS>.+?<\/TRANS>/g,'');//先去韓語
    content=content.replace(/<span data-xsl-lineid="(.+?)L" data-xsl-tag="line">(.+?)L<\/span>/g,(id)=>{
        const [m,v,p,c,l]=id.match(/(\d\d\d)_(\d\d\d\d)_([abc])_(\d\d)/);
        const page=parseInt(p);
        const col=c;
        const line=parseInt(l);
        return '\n'+v.slice(1)+'p'+p+col+l+'\t';
    });
    content=content.replace(/<span data-xsl-tag="pmark">(.+?)<\/span>/g,'$1');
    content=content.replace(/<br data-line-br=".*?">/g,'').replace(/<br data-xsl-tag="br">/g,'')
    content=content.replace(/<div data-xsl-kid=".+?" data-xsl-type=".+?" data-xsl-tag=".+?">/g,'')
    content=content.replace(/<br data-xsl-tag="p">/g,'^p')
    content=content.replace(/<span data-jusok-type="원주" data-xsl-tag="주석">(.+?)<\/span>/g,'^half〔$1〕')
    
    process.stdout.write("\r"+fn+'  '+content.length+'  ')
    sutraid=fn.replace('.html','');
    doline(content.split(/\n/));
    const vol=content.match(/\n(\d+)p\d+[abcd]\d+/)[1]
    if (prevvol!=vol) {
        emitvol();
        prevvol=vol;
    }
    //clean up unused tag
    content=content.replace(/\n\d+p(\d+[abcd]\d+)/g,'\n$1'); //remove vol at beginning of line
    content=content.replace(/\^j\d+\n/g,'').replace(/\^j\d+$/g,'');
    volcontent.push(content);
}
files.forEach(dofile)
writeChanged(outdir+'juaninfo.tsv',juaninfo.join('\n'));
emitvol();