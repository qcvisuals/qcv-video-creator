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

function getDimensions(ar) {
  const map = { '9x16':[1080,1920], '4x5':[1080,1350], '1x1':[1080,1080], '16x9':[1920,1080] };
  return map[ar] || [1080,1920];
}

function ppLayout(layout) {
  if (layout === 'side-by-side') return 2;
  if (layout === 'grid-2x2') return 4;
  return 3;
}

function runFF(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore','pipe','pipe'] });
    let err = '';
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => code === 0 ? resolve() : reject(new Error(err.slice(-800))));
  });
}

function safe(s) { return (s||'').replace(/[':]/g,'').replace(/\\/g,''); }

app.post('/generate', upload.array('photos', 25), async (req, res) => {
  const jobId = uuidv4();
  jobs[jobId] = { status:'processing', progress: 40, message:'Building video...' };
  res.json({ jobId });

  try {
    const b = req.body;
    const agentName   = b.agentName   || '';
    const agentPhone  = b.agentPhone  || '';
    const brokerage   = b.brokerage   || '';
    const address     = b.address     || '';
    const cityState   = b.cityState   || '';
    const price       = b.price       || '';
    const beds        = b.beds        || '';
    const baths       = b.baths       || '';
    const sqft        = b.sqft        || '';
    const occasion    = b.occasion    || 'For Sale';
    const bgColor     = b.bgColor     || '#1a1a1a';
    const textColor   = b.textColor   || '#ffffff';
    const accentColor = b.accentColor || '#e07940';
    const layout      = b.layout      || 'hero-pair';
    const textPos     = b.textPosition|| 'middle';
    const ar          = b.aspectRatio || '9x16';
    const numFrames   = Math.min(parseInt(b.numFrames)||3, 9);

    const [W,H] = getDimensions(ar);
    const ppf   = ppLayout(layout);
    const photos = req.files;
    const actualFrames = Math.min(numFrames, Math.ceil(photos.length/ppf));
    const dur = 3;
    const pad = Math.round(W*0.04);
    const textH = Math.round(H*0.17);
    const photoH = H - textH - pad*2;
    const photoW = W - pad*2;
    const gap = Math.round(W*0.015);

    let photoY, textY;
    if (textPos === 'bottom') { photoY = pad; textY = pad + photoH + Math.round(pad*0.4); }
    else if (textPos === 'top') { textY = pad; photoY = pad + textH + Math.round(pad*0.3); }
    else { photoY = Math.round(H*0.11); textY = photoY + photoH + Math.round(pad*0.3); }

    const fs1 = Math.round(W*0.042);
    const fs2 = Math.round(W*0.028);
    const fs3 = Math.round(W*0.022);
    const ty0 = textY + Math.round(textH*0.12);
    const ty1 = ty0 + Math.round(fs3*1.6);
    const ty2 = ty1 + Math.round(fs1*1.5);
    const ty3 = ty2 + Math.round(fs2*1.5);
    const ty4 = ty3 + Math.round(fs3*1.6);

    const fullAddr = address + (cityState ? ', '+cityState : '');
    const details = [beds?beds+' bd':'', baths?baths+' ba':'', sqft?sqft+' sqft':''].filter(Boolean).join(' | ');
    const agentLine = [agentName, agentPhone, brokerage].filter(Boolean).join(' | ');
    const bgHex = bgColor.replace('#','');
    const textHex = textColor.replace('#','');
    const accentHex = accentColor.replace('#','');

    const frameFiles = [];

    for (let f = 0; f < actualFrames; f++) {
      jobs[jobId].progress = 45 + Math.round((f/actualFrames)*40);
      jobs[jobId].message = 'Frame '+(f+1)+' of '+actualFrames+'...';

      const fp = photos.slice(f*ppf, f*ppf+ppf);
      if (!fp.length) break;

      const framePath = '/tmp/frame-'+jobId+'-'+f+'.mp4';
      frameFiles.push(framePath);

      const parts = [];
      let last = 'vbg';

      parts.push('color=0x'+bgHex+':size='+W+'x'+H+':rate=30,format=yuv420p [vbg]');

      if (layout === 'side-by-side') {
        const pw = Math.round((photoW-gap)/2);
        fp.slice(0,2).forEach((p,i) => parts.push('['+(i+1)+':v] scale='+pw+':'+photoH+' [sp'+i+']'));
        parts.push('[vbg][sp0] overlay='+pad+':'+photoY+' [ol0]'); last='ol0';
        if (fp.length>1) { parts.push('[ol0][sp1] overlay='+(pad+pw+gap)+':'+photoY+' [ol1]'); last='ol1'; }

      } else if (layout === 'grid-2x2') {
        const pw = Math.round((photoW-gap)/2);
        const ph = Math.round((photoH-gap)/2);
        const pos = [[pad,photoY],[pad+pw+gap,photoY],[pad,photoY+ph+gap],[pad+pw+gap,photoY+ph+gap]];
        fp.slice(0,4).forEach((p,i) => parts.push('['+(i+1)+':v] scale='+pw+':'+ph+' [gp'+i+']'));
        fp.slice(0,4).forEach((p,i) => {
          const prev = i===0 ? 'vbg' : 'go'+(i-1);
          parts.push('['+prev+'][gp'+i+'] overlay='+pos[i][0]+':'+pos[i][1]+' [go'+i+']');
          last='go'+i;
        });

      } else if (layout === 'feature-stack') {
        const mw = Math.round(photoW*0.60);
        const sw = photoW-mw-gap;
        const sh = Math.round((photoH-gap)/2);
        parts.push('[1:v] scale='+mw+':'+photoH+' [fp0]');
        if (fp.length>1) parts.push('[2:v] scale='+sw+':'+sh+' [fp1]');
        if (fp.length>2) parts.push('[3:v] scale='+sw+':'+sh+' [fp2]');
        parts.push('[vbg][fp0] overlay='+pad+':'+photoY+' [fo0]'); last='fo0';
        if (fp.length>1) { parts.push('[fo0][fp1] overlay='+(pad+mw+gap)+':'+photoY+' [fo1]'); last='fo1'; }
        if (fp.length>2) { parts.push('[fo1][fp2] overlay='+(pad+mw+gap)+':'+(photoY+sh+gap)+' [fo2]'); last='fo2'; }

      } else {
        const hh = Math.round(photoH*0.58);
        const ph = photoH-hh-gap;
        const pw = Math.round((photoW-gap)/2);
        parts.push('[1:v] scale='+photoW+':'+hh+' [hp0]');
        if (fp.length>1) parts.push('[2:v] scale='+pw+':'+ph+' [hp1]');
        if (fp.length>2) parts.push('[3:v] scale='+pw+':'+ph+' [hp2]');
        parts.push('[vbg][hp0] overlay='+pad+':'+photoY+' [ho0]'); last='ho0';
        if (fp.length>1) { parts.push('[ho0][hp1] overlay='+pad+':'+(photoY+hh+gap)+' [ho1]'); last='ho1'; }
        if (fp.length>2) { parts.push('[ho1][hp2] overlay='+(pad+pw+gap)+':'+(photoY+Gh+Gap)+' [ho2]'); last='ho2'; }
      }

      let draw = '['+ast+']';
      draw += " drawtext=text='"+safe(occasion)+"':x=(w-tw)/2:y="+ty0+":fontsize="+fs3+":fontcolor=0x"+accentHex+":alpha='if(gte(t\\,0.2)\\,min(1\\,(t-0.2)/0.3)\\,0)'";
      draw += ", drawtext=text='"+safe(price)+"':x=(w-tw)/2:y="+ty1+":fontsize="+fs1+":fontcolor=0x"+textHex+":alpha='if(gte(t\\,0.4)\\,min(1\\,(t-0.4)/0.3)\\,0)'";
      draw += ", drawtext=text='"+safe(fullAddr)+"':x=(w-tw)/2:y="+ty2+":fontsize="+fs2+":fontcolor=0x"+textHex+":alpha='if(gte(t\\,0.6)\\,min(1\\,(t-0.6)/0.3)\\,0)'";
      if (details) draw += ", drawtext=text='"+safe(details)+"':x=(w-tw)/2:y="+ty3+":fontsize="+fs3+":fontcolor=0x"+textHex+":alpha='if(gte(t\\,0.8)\\,min(1\\,(t-0.8)/0.3)\\,0)'";
      if (agentLine && f===actualFrames-1) draw += ", drawtext=text='"+safe(agentLine)+"':x=(w-tw)/2:y="+ty4+":fontsize="+fs3+":fontcolor=0x"+textHex+":alpha='if(gte(t\\,1.0)\\,min(1\\,(t-1.0)/0.3)\\,0)'";
      draw += ' [vtxt]';
      parts.push(draw);

      const fc = parts.join('; ');
      const args = ['-y','-f','lavfi','-i','color=0x'+bgHex+':size='+W+'x'+H+':rate=30,format=yuv420p'];
      fp.forEach(p => args.push('-loop','1','-t',String(dur),'-i',p.path));
      args.push('-filter_complex',fc,'-map','[vtxt]','-t',String(dur),'-r','30','-preset','ultrafast','-pix_fmt',yuv420p',framePath);
      await runFF(args);
    }

    jobs[jobId].progress = 88; jobs[jobId].message = 'Assembling...';
    const clist = '/tmp/concat- «jobId+'.txt';
    fs.writeFileSync(clist, frameFiles.map(f => "file '"+f+"'").join('\n'));
    const out = '/tmp/output-'+jobId+'.mp4';
    await runFF(['-y','-f','concat','-safe','0','-i',clist,'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',out]);
    frameFiles.forEach(f => { try{fs.unlinkSync(f);}catch(e){} });
    try{fs.unlinkSync(clist);}catch(e){}
    req.files.forEach(f => { try{fs.unlinkSync(f.path);}catch(e){} });
    jobs[jobId] = { status:'done', progress:100, message:'Video ready!', outputPath:out };

  } catch(err) {
    console.error(err);
    jobs[jobId] = { status:'error', progress:0, error:err.message };
    if (req.files) req.files.forEach(f => { try{fs.unlinkSync(f.path);}catch(e){} });
  }
});

app.get('/progress/:id', (req,res) => {
  const j = jobs[req.params.id];
  if (!j) return res.status(404).json({error:'Not found'});
  res.json(j);
});

app.get('/download/:id', (req,res) => {
  const j = jobs[req.params.id];
  if (!j||j.status!=='done') return res.status(404).json({error:'Not ready'});
  res.download(j.outputPath,'qcv-property-video.mp4');
});

app.listen(PORT, () => console.log('QCV running on port '+PORT));
