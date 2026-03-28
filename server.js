const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/uploads/' });

app.use(express.static(path.join(__dirname, 'public')));

const jobs = {};

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `${r}/${g}/${b}`;
}

function getDimensions(aspectRatio) {
  const map = { '9x16': [1080,1920], '4x5': [1080,1350], '1x1': [1080,1080], '16x9': [1920,1080] };
  return map[aspectRatio] || [1080,1920];
}

function getPhotosPerFrame(layout) {
  const map = { 'hero-pair': 3, 'side-by-side': 2, 'feature-stack': 3, 'grid-2x2': 4 };
  return map[layout] || 3;
}

app.post('/generate', upload.array('photos', 25), async (req, res) => {
  const jobId = uuidv4();
  jobs[jobId] = { status: 'processing', progress: 40, message: 'Photos received, building video...' };
  res.json({ jobId });

  const { agentName, agentPhone, brokerage, address, cityState, price, beds, baths, sqft, occasion,
          bgColor, textColor, accentColor, layout, textPosition, aspectRatio, numFrames, transition } = req.body;

  const [W, H] = getDimensions(aspectRatio || '9x16');
  const photosPerFrame = getPhotosPerFrame(layout || 'hero-pair');
  const photos = req.files;
  const numF = Math.min(parseInt(numFrames) || 3, Math.ceil(photos.length / photosPerFrame));
  const outputPath = `/tmp/output-${jobId}.mp4`;
  const frameDuration = 3;

  try {
    jobs[jobId].progress = 45;
    jobs[jobId].message = 'Preparing frames...';

    const bg = hexToRgb(bgColor || '#1a1a1a');
    const tc = hexToRgb(textColor || '#ffffff');
    const ac = hexToRgb(accentColor || '#e07940');

    const pad = Math.round(W * 0.04);
    const textH = Math.round(H * 0.18);
    const photoAreaH = H - textH - pad * 2;
    const photoAreaW = W - pad * 2;
    const photoAreaY = textPosition === 'bottom' ? pad : textPosition === 'top' ? H - photoAreaH - pad : Math.round(H * 0.12);
    const textAreaY = textPosition === 'bottom' ? photoAreaY + photoAreaH + Math.round(pad * 0.5)
                    : textPosition === 'top' ? pad
                    : Math.round(H * 0.12) + photoAreaH + Math.round(pad * 0.3);

    const frameFiles = [];

    for (let f = 0; f < numF; f++) {
      jobs[jobId].progress = 45 + Math.round((f / numF) * 40);
      jobs[jobId].message = `Building frame ${f+1} of ${numF}...`;

      const framePhotos = photos.slice(f * photosPerFrame, f * photosPerFrame + photosPerFrame);
      if (framePhotos.length === 0) break;

      const framePath = `/tmp/frame-${jobId}-${f}.mp4`;
      frameFiles.push(framePath);

      // Build photo layout filter
      let filterComplex = '';
      let overlayChain = '';
      const gap = Math.round(W * 0.015);

      if (layout === 'side-by-side') {
        const pw = Math.round((photoAreaW - gap) / 2);
        const ph = photoAreaH;
        filterComplex = framePhotos.slice(0,2).map((p,i) => {
          const x = pad + i * (pw + gap);
          return `[v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}in${i}] scale=${pw}:${ph}:force_original_aspect_ratio=cover,crop=${pw}:${ph} [v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p${i}];`;
        }).join('');
        filterComplex += `color=${bg}:${W}x${H},format=yuv420p [vbg${f}];`;
        filterComplex += `[vbg${f}][v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p0] overlay=${pad}:${photoAreaY} [vo${f}0];`;
        if (framePhotos.length > 1) filterComplex += `[vo${f}0][v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p1] overlay=${pad + pw + gap}:${photoAreaY} [vfinal${f}];`;
        else filterComplex += `[vo${f}0] copy [vfinal${f}];`;
      } else if (layout === 'grid-2x2') {
        const pw = Math.round((photoAreaW - gap) / 2);
        const ph = Math.round((photoAreaH - gap) / 2);
        filterComplex = framePhotos.slice(0,4).map((p,i) => {
          return `[v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}in${i}] scale=${pw}:${ph}:force_original_aspect_ratio=cover,crop=${pw}:${ph} [v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p${i}];`;
        }).join('');
        filterComplex += `color=${bg}:${W}x${H},format=yuv420p [vbg${f}];`;
        const positions = [[pad,photoAreaY],[pad+pw+gap,photoAreaY],[pad,photoAreaY+ph+gap],[pad+pw+gap,photoAreaY+ph+gap]];
        filterComplex += `[vbg${f}][v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p0] overlay=${positions[0][0]}:${positions[0][1]} [vo${f}0];`;
        for (let i=1; i<Math.min(framePhotos.length,4); i++) {
          filterComplex += `[vo${f}${i-1}][v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p${i}] overlay=${positions[i][0]}:${positions[i][1]} ${i<Math.min(framePhotos.length,4)-1 ? '[vo'+f+i+'];' : '[vfinal'+f+'];'}`;
        }
        if (framePhotos.length === 1) filterComplex += `[vo${f}0] copy [vfinal${f}];`;
      } else if (layout === 'feature-stack') {
        const mainW = Math.round(photoAreaW * 0.6);
        const stackW = photoAreaW - mainW - gap;
        const stackH = Math.round((photoAreaH - gap) / 2);
        filterComplex = `[v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}in0] scale=${mainW}:${photoAreaH}:force_original_aspect_ratio=cover,crop=${mainW}:${photoAreaH} [v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p0];`;
        if (framePhotos.length > 1) filterComplex += `[v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}in1] scale=${stackW}:${stackH}:force_original_aspect_ratio=cover,crop=${stackW}:${stackH} [v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p1];`;
        if (framePhotos.length > 2) filterComplex += `[v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}in2] scale=${stackW}:${stackH}:force_original_aspect_ratio=cover,crop=${stackW}:${stackH} [v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p2];`;
        filterComplex += `color=${bg}:${W}x${H},format=yuv420p [vbg${f}];`;
        filterComplex += `[vbg${f}][v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p0] overlay=${pad}:${photoAreaY} [vo${f}0];`;
        if (framePhotos.length > 1) {
          filterComplex += `[vo${f}0][v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p1] overlay=${pad+mainW+gap}:${photoAreaY} [vo${f}1];`;
          if (framePhotos.length > 2) filterComplex += `[vo${f}1][v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p2] overlay=${pad+mainW+gap}:${photoAreaY+stackH+gap} [vfinal${f}];`;
          else filterComplex += `[vo${f}1] copy [vfinal${f}];`;
        } else filterComplex += `[vo${f}0] copy [vfinal${f}];`;
      } else {
        // hero-pair default
        const heroH = Math.round(photoAreaH * 0.58);
        const pairH = photoAreaH - heroH - gap;
        const pairW = Math.round((photoAreaW - gap) / 2);
        filterComplex = `[v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}in0] scale=${photoAreaW}:${heroH}:force_original_aspect_ratio=cover,crop=${photoAreaW}:${heroH} [v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p0];`;
        if (framePhotos.length > 1) filterComplex += `[v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}in1] scale=${pairW}:${pairH}:force_original_aspect_ratio=cover,crop=${pairW}:${pairH} [v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p1];`;
        if (framePhotos.length > 2) filterComplex += `[v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}in2] scale=${pairW}:${pairH}:force_original_aspect_ratio=cover,crop=${pairW}:${pairH} [v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p2];`;
        filterComplex += `color=${bg}:${W}x${H},format=yuv420p [vbg${f}];`;
        filterComplex += `[vbg${f}][v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p0] overlay=${pad}:${photoAreaY} [vo${f}0];`;
        if (framePhotos.length > 1) {
          filterComplex += `[vo${f}0][v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p1] overlay=${pad}:${photoAreaY+heroH+gap} [vo${f}1];`;
          if (framePhotos.length > 2) filterComplex += `[vo${f}1][v:class f extends HTMLElement{async connectedCallback(){p("concurrency-error")}}p2] overlay=${pad+pairW+gap}:${photoAreaY+heroH+gap} [vfinal${f}];`;
          else filterComplex += `[vo${f}1] copy [vfinal${f}];`;
        } else filterComplex += `[vo${f}0] copy [vfinal${f}];`;
      }

      // Text overlays on background
      const priceText = price || '';
      const addressText = (address || '') + (cityState ? ', ' + cityState : '');
      const detailText = [beds ? beds + ' bd' : '', baths ? baths + ' ba' : '', sqft ? sqft + ' sqft' : ''].filter(Boolean).join('  ·  ');
      const agentText = [agentName, agentPhone, brokerage].filter(Boolean).join('  |  ');
      const fs1 = Math.round(W * 0.042);
      const fs2 = Math.round(W * 0.028);
      const fs3 = Math.round(W * 0.024);
      const ty1 = textAreaY + Math.round(textH * 0.18);
      const ty2 = ty1 + Math.round(fs1 * 1.5);
      const ty3 = ty2 + Math.round(fs2 * 1.6);
      const ty4 = ty3 + Math.round(fs3 * 1.8);

      // Remove trailing semicolon from filter if present, add text
      filterComplex = filterComplex.replace(/[vfinal${f}];$/, `[vfinal${f}]`);
      filterComplex += `, drawtext=text='':x=0:y=0`;
      filterComplex += `, drawtext=text='${occasion || 'For Sale'}':x=(W-tw)/2:y=${ty1}:fontsize=${fs3}:fontcolor=${ac}:font=Sans:alpha='if(gte(t,0.3),min(1,(t-0.3)/0.4),0)'`;
      filterComplex += `, drawtext=text='${priceText.replace(/'/g,'')}':x=(W-tw)/2:y=${ty2}:fontsize=${fs1}:fontcolor=${tc}:font=Sans Bold:alpha='if(gte(t,0.5),min(1,(t-0.5)/0.4),0)'`;
      filterComplex += `, drawtext=text='${addressText.replace(/'/g,'')}':x=(W-tw)/2:y=${ty3}:fontsize=${fs2}:fontcolor=${tc}:font=Sans:alpha='if(gte(t,0.7),min(1,(t-0.7)/0.4),0)'`;
      if (detailText) filterComplex += `, drawtext=text='${detailText}':x=(W-tw)/2:y=${ty4}:fontsize=${fs3}:fontcolor=${tc}:font=Sans:alpha='if(gte(t,0.9),min(1,(t-0.9)/0.4),0)'`;

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg().outputOptions(['-t', frameDuration, '-r', '30', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p']);
        framePhotos.forEach(p => cmd = cmd.input(p.path).inputOptions(['-loop', '1', '-t', frameDuration]));
        const cleanFilter = filterComplex.replace(/v:${f}in/g, (_, i) => 'v' + f + 'in').replace(/v:${f}p/g, 'v' + f + 'p');
        cmd.complexFilter(filterComplex).map('[vfinal' + f + ']').output(framePath).on('end', resolve).on('error', reject).run();
      });
    }

    jobs[jobId].progress = 88;
    jobs[jobId].message = 'Assembling final video...';

    // Concat all frames
    const concatList = `/tmp/concat-${jobId}.txt`;
    fs.writeFileSync(concatList, frameFiles.map(f => `file '${f}'`).join('\n'));

    await new Promise((resolve, reject) => {
      ffmpeg().input(concatList).inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'])
        .output(outputPath).on('end', resolve).on('error', reject).run();
    });

    frameFiles.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    try { fs.unlinkSync(concatList); } catch(e) {}
    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(e) {} });

    jobs[jobId] = { status: 'done', progress: 100, message: 'Video ready!', outputPath };
  } catch (err) {
    console.error('Error:', err);
    jobs[jobId] = { status: 'error', progress: 0, error: err.message };
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
