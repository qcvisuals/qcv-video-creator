const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { execSync, spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/uploads/' });

app.use(express.static(path.join(__dirname, 'public')));

const jobs = {};

function hexToRgb(hex) {
  hex = hex.replace('#', '');
  const r = parseInt(hex.slice(0,2),16);
  const g = parseInt(hex.slice(2,4),16);
  const b = parseInt(hex.slice(4,6),16);
  return r + '/' + g + '/' + b;
}

function getDimensions(aspectRatio) {
  const map = { '9x16': [1080,1920], '4x5': [1080,1350], '1x1': [1080,1080], '16x9': [1920,1080] };
  return map[aspectRatio] || [1080,1920];
}

function photosPerLayout(layout) {
  if (layout === 'side-by-side') return 2;
  if (layout === 'grid-2x2') return 4;
  return 3;
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore','pipe','pipe'] });
    let err = '';
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', code => code === 0 ? resolve() : reject(new Error('FFmpeg error: ' + err.slice(-500))));
  });
}

app.post('/generate', upload.array('photos', 25), async (req, res) => {
  const jobId = uuidv4();
  jobs[jobId] = { status: 'processing', progress: 40, message: 'Photos received, building video...' };
  res.json({ jobId });

  try {
    const agentName = req.body.agentName || '';
    const agentPhone = req.body.agentPhone || '';
    const brokerage = req.body.brokerage || '';
    const address = req.body.address || '';
    const cityState = req.body.cityState || '';
    const price = req.body.price || '';
    const beds = req.body.beds || '';
    const baths = req.body.baths || '';
    const sqft = req.body.sqft || '';
    const occasion = req.body.occasion || 'For Sale';
    const bgColor = req.body.bgColor || '#1a1a1a';
    const textColor = req.body.textColor || '#ffffff';
    const accentColor = req.body.accentColor || '#e07940';
    const layout = req.body.layout || 'hero-pair';
    const textPosition = req.body.textPosition || 'middle';
    const aspectRatio = req.body.aspectRatio || '9x16';
    const numFrames = Math.min(parseInt(req.body.numFrames) || 3, 9);
    const transition = req.body.transition || 'fade';

    const [W, H] = getDimensions(aspectRatio);
    const ppf = photosPerLayout(layout);
    const photos = req.files;
    const actualFrames = Math.min(numFrames, Math.ceil(photos.length / ppf));
    const frameDur = 3;
    const pad = Math.round(W * 0.04);
    const textH = Math.round(H * 0.17);
    const photoH = H - textH - pad * 2;
    const photoW = W - pad * 2;

    let photoAreaY, textAreaY;
    if (textPosition === 'bottom') {
      photoAreaY = pad;
      textAreaY = pad + photoH + Math.round(pad * 0.4);
    } else if (textPosition === 'top') {
      textAreaY = pad;
      photoAreaY = pad + textH + Math.round(pad * 0.3);
    } else {
      photoAreaY = Math.round(H * 0.11);
      textAreaY = photoAreaY + photoH + Math.round(pad * 0.3);
    }

    const bg = hexToRgb(bgColor);
    const tc = hexToRgb(textColor);
    const ac = hexToRgb(accentColor);

    const fullAddr = address + (cityState ? ', ' + cityState : '');
    const details = [beds ? beds + ' bd' : '', baths ? baths + ' ba' : '', sqft ? sqft + ' sqft' : ''].filter(Boolean).join('  |  ');
    const agentLine = [agentName, agentPhone, brokerage].filter(Boolean).join('  |  ');

    const fs1 = Math.round(W * 0.042);
    const fs2 = Math.round(W * 0.028);
    const fs3 = Math.round(W * 0.022);

    const ty0 = textAreaY + Math.round(textH * 0.12);
    const ty1 = ty0 + Math.round(fs3 * 1.6);
    const ty2 = ty1 + Math.round(fs1 * 1.5);
    const ty3 = ty2 + Math.round(fs2 * 1.5);
    const ty4 = ty3 + Math.round(fs3 * 1.6);

    const gap = Math.round(W * 0.015);
    const frameFiles = [];

    for (let f = 0; f < actualFrames; f++) {
      jobs[jobId].progress = 45 + Math.round((f / actualFrames) * 40);
      jobs[jobId].message = 'Building frame ' + (f+1) + ' of ' + actualFrames + '...';

      const framePhotos = photos.slice(f * ppf, f * ppf + ppf);
      if (framePhotos.length === 0) break;

      const framePath = '/tmp/frame-' + jobId + '-' + f + '.mp4';
      frameFiles.push(framePath);

      // Build inputs and filter for this frame
      let inputs = [];
      let filterParts = [];
      let lastLabel = 'vbg';

      // Background
      filterParts.push('color=r=' + bg.split('/')[0] + ':g=' + bg.split('/')[1] + ':b=' + bg.split('/')[2] + ':size=' + W + 'x' + H + ':rate=30,format=yuv420p [vbg]');

      framePhotos.forEach((p, i) => inputs.push(p.path));

      if (layout === 'side-by-side') {
        const pw = Math.round((photoW - gap) / 2);
        framePhotos.slice(0,2).forEach((p, i) => {
          filterParts.push('[' + (i+1) + ':v] scale=' + pw + ':' + photoH + ':force_original_aspect_ratio=cover,crop=' + pw + ':' + photoH + ',setsar=1 [sp' + i + ']');
        });
        filterParts.push('[' + lastLabel + '][sp0] overlay=' + pad + ':' + photoAreaY + ' [ol0]');
        lastLabel = 'ol0';
        if (framePhotos.length > 1) {
          filterParts.push('[' + lastLabel + '][sp1] overlay=' + (pad + pw + gap) + ':' + photoAreaY + ' [ol1]');
          lastLabel = 'ol1';
        }
      } else if (layout === 'grid-2x2') {
        const pw = Math.round((photoW - gap) / 2);
        const ph = Math.round((photoH - gap) / 2);
        const positions = [[pad, photoAreaY], [pad+pw+gap, photoAreaY], [pad, photoAreaY+ph+gap], [pad+pw+gap, photoAreaY+ph+gap]];
        framePhotos.slice(0,4).forEach((p, i) => {
          filterParts.push('[' + (i+1) + ':v] scale=' + pw + ':' + ph + ':force_original_aspect_ratio=cover,crop=' + pw + ':' + ph + ',setsar=1 [gp' + i + ']');
        });
        framePhotos.slice(0,4).forEach((p, i) => {
          const nextLabel = 'go' + i;
          filterParts.push('[' + lastLabel + '][gp' + i + '] overlay=' + positions[i][0] + ':' + positions[i][1] + ' [' + nextLabel + ']');
          lastLabel = nextLabel;
        });
      } else if (layout === 'feature-stack') {
        const mainW = Math.round(photoW * 0.60);
        const stackW = photoW - mainW - gap;
        const stackH = Math.round((photoH - gap) / 2);
        filterParts.push('[1:v] scale=' + mainW + ':' + photoH + ':force_original_aspect_ratio=cover,crop=' + mainW + ':' + photoH + ',setsar=1 [fp0]');
        if (framePhotos.length > 1) filterParts.push('[2:v] scale=' + stackW + ':' + stackH + ':force_original_aspect_ratio=cover,crop=' + stackW + ':' + stackH + ',setsar=1 [fp1]');
        if (framePhotos.length > 2) filterParts.push('[3:v] scale=' + stackW + ':' + stackH + ':force_original_aspect_ratio=cover,crop=' + stackW + ':' + stackH + ',setsar=1 [fp2]');
        filterParts.push('[vbg][fp0] overlay=' + pad + ':' + photoAreaY + ' [fo0]');
        lastLabel = 'fo0';
        if (framePhotos.length > 1) {
          filterParts.push('[fo0][fp1] overlay=' + (pad+mainW+gap) + ':' + photoAreaY + ' [fo1]');
          lastLabel = 'fo1';
          if (framePhotos.length > 2) {
            filterParts.push('[fo1][fp2] overlay=' + (pad+mainW+gap) + ':' + (photoAreaY+stackH+gap) + ' [fo2]');
            lastLabel = 'fo2';
          }
        }
      } else {
        // hero-pair
        const heroH = Math.round(photoH * 0.58);
        const pairH = photoH - heroH - gap;
        const pairW = Math.round((photoW - gap) / 2);
        filterParts.push('[1:v] scale=' + photoW + ':' + heroH + ':force_original_aspect_ratio=cover,crop=' + photoW + ':' + heroH + ',setsar=1 [hp0]');
        if (framePhotos.length > 1) filterParts.push('[2:v] scale=' + pairW + ':' + pairH + ':force_original_aspect_ratio=cover,crop=' + pairW + ':' + pairH + ',setsar=1 [hp1]');
        if (framePhotos.length > 2) filterParts.push('[3:v] scale=' + pairW + ':' + pairH + ':force_original_aspect_ratio=cover,crop=' + pairW + ':' + pairH + ',setsar=1 [hp2]');
        filterParts.push('[vbg][hp0] overlay=' + pad + ':' + photoAreaY + ' [ho0]');
        lastLabel = 'ho0';
        if (framePhotos.length > 1) {
          filterParts.push('[ho0][hp1] overlay=' + pad + ':' + (photoAreaY+heroH+gap) + ' [ho1]');
          lastLabel = 'ho1';
          if (framePhotos.length > 2) {
            filterParts.push('[ho1][hp2] overlay=' + (pad+pairW+gap) + ':' + (photoAreaY+heroH+gap) + ' [ho2]');
            lastLabel = 'ho2';
          }
        }
      }

      // Text drawtext filters chained on lastLabel
      const safe = s => (s || '').replace(/'/g, '').replace(/:/g, '').replace(/\\/g, '');
      let drawChain = '[' + lastLabel + ']';
      drawChain += ' drawtext=text=\'' + safe(occasion) + '\':x=(w-tw)/2:y=' + ty0 + ':fontsize=' + fs3 + ':fontcolor=0x' + accentColor.replace('#','') + ':alpha=\'if(gte(t\\,0.2)\\,min(1\\,(t-0.2)/0.3)\\,0)\'';
      drawChain += ', drawtext=text=\'' + safe(price) + '\':x=(w-tw)/2:y=' + ty1 + ':fontsize=' + fs1 + ':fontcolor=0x' + textColor.replace('#','') + ':alpha=\'if(gte(t\\,0.4)\\,min(1\\,(t-0.4)/0.3)\\,0)\'';
      drawChain += ', drawtext=text=\'' + safe(fullAddr) + '\':x=(w-tw)/2:y=' + ty2 + ':fontsize=' + fs2 + ':fontcolor=0x' + textColor.replace('#','') + ':alpha=\'if(gte(t\\,0.6)\\,min(1\\,(t-0.6)/0.3)\\,0)\'';
      if (details) drawChain += ', drawtext=text=\'' + safe(details) + '\':x=(w-tw)/2:y=' + ty3 + ':fontsize=' + fs3 + ':fontcolor=0x' + textColor.replace('#','') + ':alpha=\'if(gte(t\\,0.8)\\,min(1\\,(t-0.8)/0.3)\\,0)\'';
      if (agentLine && f === actualFrames - 1) drawChain += ', drawtext=text=\'' + safe(agentLine) + '\':x=(w-tw)/2:y=' + ty4 + ':fontsize=' + fs3 + ':fontcolor=0x' + textColor.replace('#','') + ':alpha=\'if(gte(t\\,1.0)\\,min(1\\,(t-1.0)/0.3)\\,0)\'';
      drawChain += ' [vtxt]';

      filterParts.push(drawChain);

      const filterComplex = filterParts.join('; ');

      const ffArgs = ['-y'];
      ffArgs.push('-f', 'lavfi', '-i', 'color=r=' + bg.split('/')[0] + ':g=' + bg.split('/')[1] + ':b=' + bg.split('/')[2] + ':size=' + W + 'x' + H + ':rate=30,format=yuv420p');
      inputs.forEach(p => ffArgs.push('-loop', '1', '-t', String(frameDur), '-i', p));
      ffArgs.push('-filter_complex', filterComplex);
      ffArgs.push('-map', '[vtxt]');
      ffArgs.push('-t', String(frameDur), '-r', '30', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', framePath);

      await runFFmpeg(ffArgs);
    }

    jobs[jobId].progress = 88;
    jobs[jobId].message = 'Assembling final video...';

    const concatList = '/tmp/concat-' + jobId + '.txt';
    fs.writeFileSync(concatList, frameFiles.map(f => "file '" + f + "'").join('\n'));

    const outputPath = '/tmp/output-' + jobId + '.mp4';
    await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', outputPath]);

    frameFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    try { fs.unlinkSync(concatList); } catch(e) {}
    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(e) {} });

    jobs[jobId] = { status: 'done', progress: 100, message: 'Video ready!', outputPath };

  } catch (err) {
    console.error('Error:', err);
    jobs[jobId] = { status: 'error', progress: 0, error: err.message };
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(e) {} });
  }
});

app.get('/progress/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/download/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  res.download(job.outputPath, 'qcv-property-video.mp4');
});

app.listen(PORT, () => console.log('QCV Video Creator running on port ' + PORT));
