const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/uploads/' });
app.use(express.static(path.join(__dirname, 'public')));
const jobs = {};
function getDim(ar) {
  const m = {'9x16':[1080,1920],'4x5':[1080,1350],'1x1':[1080,1080],'16x9':[1920,1080]};
  return m[ar] || [1080,1920];
}
function ppf(layout) {
  if (layout==='side-by-side') return 2;
  if (layout==='grid-2x2') return 4;
  return 3;
}
function runFF(args) {
  return new Promise((resolve,reject) => {
    const p = spawn('ffmpeg',args,{stdio:['ignore','pipe','pipe']});
    let e='';
    p.stderr.on('data',d=>e+=d.toString());
    p.on('close',c=>c===0?resolve():reject(new Error(e.slice(-600))));
  });
}
function safe(s){return (s||'').replace(/[':]/g,'').replace(/\\/g,'');}
app.post('/generate',upload.array('photos',25),async(req,res)=>{
  const jobId=uuidv4();
  jobs[jobId]={status:'processing',progress:40,message:'Building...'};
  res.json({jobId});
  try {
    const b=req.body;
    const bgHex=(b.bgColor||'#1a1a1a').replace('#','');
    const textHex=(b.textColor||'#ffffff').replace('#','');
    const accentHex=(b.accentColor||'#e07940').replace('#','');
    const layout=b.layout||'hero-pair';
    const textPos=b.textPosition||'middle';
    const ar=b.aspectRatio||'9x16';
    const nf=Math.min(parseInt(b.numFrames)||3,9);
    const addr=(b.address||'')+(b.cityState?', '+b.cityState:'');
    const price=b.price||'';
    const occasion=b.occasion||'For Sale';
    const details=[b.beds?b.beds+' bd':'',b.baths?b.baths+' ba':'',b.sqft?b.sqft+' sqft':''].filter(Boolean).join(' | ');
    const agent=[b.agentName,b.agentPhone,b.brokerage].filter(Boolean).join(' | ');
    const [W,H]=getDim(ar);
    const pp=ppf(layout);
    const photos=req.files;
    const af=Math.min(nf,Math.ceil(photos.length/pp));
    const dur=3;
    const pad=Math.round(W*0.04);
    const tH=Math.round(H*0.17);
    const pH=H-tH-pad*2;
    const pW=W-pad*2;
    const gap=Math.round(W*0.015);
    let pY,tY;
    if(textPos==='bottom'){pY=pad;tY=pad+pH+Math.round(pad*0.4);}
    else if(textPos==='top'){tY=pad;pY=pad+tH+Math.round(pad*0.3);}
    else{pY=Math.round(H*0.11);tY=pY+pH+Math.round(pad*0.3);}
    const f1=Math.round(W*0.042),f2=Math.round(W*0.028),f3=Math.round(W*0.022);
    const t0=tY+Math.round(tH*0.12);
    const t1=t0+Math.round(f3*1.6);
    const t2=t1+Math.round(f1*1.5);
    const t3=t2+Math.round(f2*1.5);
    const t4=t3+Math.round(f3*1.6);
    const ff=[];
    for(let i=0;i<af;i++){
      jobs[jobId].progress=45+Math.round((i/af)*40);
      jobs[jobId].message='Frame '+(i+1)+' of '+af+'...';
      const fp=photos.slice(i*pp,i*pp+pp);
      if(!fp.length)break;
      const fpath='/tmp/frame-'+jobId+'-'+i+'.mp4';
      ff.push(fpath);
      const pts=[];
      let last='vbg';
      pts.push('color=0x'+bgHex+':size='+W+'x'+H+':rate=30,format=yuv420p [vbg]');
      if(layout==='side-by-side'){
        const pw=Math.round((pW-gap)/2);
        fp.slice(0,2).forEach((x,j)=>pts.push('['+(j+1)+':v] scale='+pw+':'+pH+' [sp'+j+']'));
        pts.push('[vbg][sp0] overlay='+pad+':'+pY+' [ol0]');last='ol0';
        if(fp.length>1){pts.push('[ol0][sp1] overlay='+(pad+pw+gap)+':'+pY+' [ol1]');last='ol1';}
      } else if(layout==='grid-2x2'){
        const pw=Math.round((pW-gap)/2),ph=Math.round((pH-gap)/2);
        const pos=[[pad,pY],[pad+pw+gap,pY],[pad,pY+ph+gap],[pad+pw+gap,pY+ph+gap]];
        fp.slice(0,4).forEach((x,j)=>pts.push('['+(j+1)+':v] scale='+pw+':'+ph+' [gp'+j+']'));
        fp.slice(0,4).forEach((x,j)=>{
          const prev=j===0?'vbg':'go'+(j-1);
          pts.push('['+prev+'][gp'+j+'] overlay='+pos[j][0]+':'+pos[j][1]+' [go'+j+']');
          last='go'+j;
        });
      } else if(layout==='feature-stack'){
        const mw=Math.round(pW*0.6),sw=pW-mw-gap,sh=Math.round((pH-gap)/2);
        pts.push('[1:v] scale='+mw+':'+pH+' [fp0]');
        if(fp.length>1)pts.push('[2:v] scale='+sw+':'+sh+' [fp1]');
        if(fp.length>2)pts.push('[3:v] scale='+sw+':'+sh+' [fp2]');
        pts.push('[vbg][fp0] overlay='+pad+':'+pY+' [fo0]');last='fo0';
        if(fp.length>1){pts.push('[fo0][fp1] overlay='+(pad+mw+gap)+':'+pY+' [fo1]');last='fo1';}
        if(fp.length>2){pts.push('[fo1][fp2] overlay='+(pad+mw+gap)+':'+(pY+sh+gap)+' [fo2]');last='fo2';}
      } else {
        const hh=Math.round(pH*0.58),ph=pH-hh-gap,pw=Math.round((pW-gap)/2);
        pts.push('[1:v] scale='+pW+':'+hh+' [hp0]');
        if(fp.length>1)pts.push('[2:v] scale='+pw+':'+ph+' [hp1]');
        if(fp.length>2)pts.push('[3:v] scale='+pw+':'+ph+' [hp2]');
        pts.push('[vbg][hp0] overlay='+pad+':'+pY+' [ho0]');last='ho0';
        if(fp.length>1){pts.push('[ho0][hp1] overlay='+pad+':'+(pY+hh+gap)+' [ho1]');last='ho1';}
        if(fp.length>2){pts.push('[ho1][hp2] overlay='+(pad+pw+gap)+':'+(pY+hh+gap)+' [ho2]');last='ho2';}
      }
      let draw='['+last+']';
      draw+=" drawtext=text='"+safe(occasion)+"':x=(w-tw)/2:y="+t0+":fontsize="+f3+":fontcolor=0x"+accentHex+":alpha='if(gte(t\\,0.2)\\,min(1\\,(t-0.2)/0.3)\\,0)'";
      draw+=", drawtext=text='"+safe(price)+"':x=(w-tw)/2:y="+t1+":fontsize="+f1+":fontcolor=0x"+textHex+":alpha='if(gte(t\\,0.4)\\,min(1\\,(t-0.4)/0.3)\\,0)'";
      draw+=", drawtext=text='"+safe(addr)+"':x=(w-tw)/2:y="+t2+":fontsize="+f2+":fontcolor=0x"+textHex+":alpha='if(gte(t\\,0.6)\\,min(1\\,(t-0.6)/0.3)\\,0)'";
      if(details)draw+=", drawtext=text='"+safe(details)+"':x=(w-tw)/2:y="+t3+":fontsize="+f3+":fontcolor=0x"+textHex+":alpha='if(gte(t\\,0.8)\\,min(1\\,(t-0.8)/0.3)\\,0)'";
      if(agent&&i===af-1)draw+=", drawtext=text='"+safe(agent)+"':x=(w-tw)/2:y="+t4+":fontsize="+f3+":fontcolor=0x"+textHex+":alpha='if(gte(t\\,1.0)\\,min(1\\,(t-1.0)/0.3)\\,0)'";
      draw+=' [vtxt]';
      pts.push(draw);
      const fc=pts.join('; ');
      const args=['-y','-f','lavfi','-i','color=0x'+bgHex+':size='+W+'x'+H+':rate=30,format=yuv420p'];
      fp.forEach(x=>args.push('-loop','1','-t',String(dur),'-i',x.path));
      args.push('-filter_complex',fc,'-map','[vtxt]','-t',String(dur),'-r','30','-preset','ultrafast','-pix_fmt','yuv420p',fpath);
      await runFF(args);
    }
    jobs[jobId].progress=88;jobs[jobId].message='Assembling...';
    const cl='/tmp/concat-'+jobId+'.txt';
    fs.writeFileSync(cl,ff.map(x=>"file '"+x+"'").join('\n'));
    const out='/tmp/output-'+jobId+'.mp4';
    await runFF(['-y','-f','concat','-safe','0','-i',cl,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',out]);
    ff.forEach(x=>{try{fs.unlinkSync(x);}catch(e){}});
    try{fs.unlinkSync(cl);}catch(e){}
    req.files.forEach(x=>{try{fs.unlinkSync(x.path);}catch(e){}});
    jobs[jobId]={status:'done',progress:100,message:'Ready!',outputPath:out};
  } catch(err){
    console.error(err);
    jobs[jobId]={status:'error',progress:0,error:err.message};
    if(req.files)req.files.forEach(x=>{try{fs.unlinkSync(x.path);}catch(e){}});
  }
});
app.get('/progress/:id',(req,res)=>{
  const j=jobs[req.params.id];
  if(!j)return res.status(404).json({error:'Not found'});
  res.json(j);
});
app.get('/download/:id',(req,res)=>{
  const j=jobs[req.params.id];
  if(!j||j.status!=='done')return res.status(404).json({error:'Not ready'});
  res.download(j.outputPath,'qcv-property-video.mp4');
});
app.listen(PORT,()=>console.log('QCV running on port '+PORT));