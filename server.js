const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 8080;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');
const MUSIC_DIR = path.join(__dirname, 'music');
[UPLOADS_DIR, OUTPUTS_DIR, MUSIC_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));
const jobs = new Map();
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const jobId = req.jobId || (req.jobId = uuidv4());
    const dir = path.join(UPLOADS_DIR, jobId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9._]/g,'_'))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.static(path.join(__dirname, 'public')));
app.post('/api/generate-video', (req, res, next) => { req.jobId = uuidv4(); next(); },
  upload.fields([{ name: 'photos', maxCount: 10 }, { name: 'logo', maxCount: 1 }]),
  async (req, res) => {
    try {
      const jobId = req.jobId;
      const { address, price, beds, baths, sqft, tagline, agentName, agentPhone, musicMood, videoFormat, transition } = req.body;
      const photos = (req.files['photos'] || []).map(f => f.path).sort();
      const logoFile = req.files['logo'] ? req.files['logo'][0].path : null;
      if (!photos.length) return res.status(400).json({ error: 'At least 1 photo required' });
      jobs.set(jobId, { status: 'processing', progress: 30, message: 'Photos received — starting render...' });
      res.json({ jobId });
      processVideo({ jobId, photos, logoFile, address, price, beds, baths, sqft, tagline, agentName, agentPhone, musicMood, videoFormat, transition: transition || 'Fade' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ status: job.status, progress: job.progress, message: job.message });
});
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || job.status !== 'complete') return res.status(404).json({ error: 'Video not ready' });
  if (!fs.existsSync(job.outputPath)) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Disposition', 'attachment; filename="property-video.mp4"');
  res.setHeader('Content-Type', 'video/mp4');
  res.download(job.outputPath, 'property-video.mp4');
});

async function processVideo({ jobId, photos, logoFile, address, price, beds, baths, sqft, tagline, agentName, agentPhone, musicMood, videoFormat, transition }) {
  const update = (status, progress, message) => jobs.set(jobId, { ...jobs.get(jobId), status, progress, message });
  try {
    const workDir = path.join(UPLOADS_DIR, jobId);
    const outputPath = path.join(OUTPUTS_DIR, jobId + '.mp4');
    const formats = { '9x16': { w: 1080, h: 1920 }, '4x5': { w: 1080, h: 1350 }, '1x1': { w: 1080, h: 1080 }, '16x9': { w: 1920, h: 1080 } };
    const { w, h } = formats[videoFormat] || formats['9x16'];
    const DUR = 2.5;
    const FPS = 30;
    const FRAMES = Math.round(DUR * FPS);
    const PRESET = 'ultrafast';

    const segments = [];
    for (let i = 0; i < photos.length; i++) {
      const pct = Math.round(30 + (i / photos.length) * 40);
      update('processing', pct, 'Rendering photo ' + (i+1) + ' of ' + photos.length + '...');
      const segOut = path.join(workDir, 'seg_' + i + '.mp4');
      const zoompan = 'zoompan=z=\'min(zoom+0.0006,1.06)\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=' + FRAMES + ':s=' + w + 'x' + h + ':fps=' + FPS;
      let filter = '[0:v]scale=' + (w*2) + ':' + (h*2) + ',' + zoompan;
      const txt = getTextOverlay(i, address, price, beds, baths, sqft, tagline, w, h);
      if (txt) filter += ',' + txt;
      filter += '[v]';
      await runFFmpeg(['-loop','1','-t',String(DUR + 0.5),'-i',photos[i],'-filter_complex',filter,'-map','[v]','-c:v','libx264','-preset',PRESET,'-pix_fmt','yuv420p','-r',String(FPS),'-t',String(DUR + 0.5),'-y',segOut]);
      segments.push(segOut);
    }

    update('processing', 72, 'Building end card...');
    const endCard = path.join(workDir, 'endcard.mp4');
    await runFFmpeg(['-f','lavfi','-i','color=c=black:s='+w+'x'+h+':d=3.5:r='+FPS,'-filter_complex',buildEndCard(agentName,agentPhone,w,h),'-map','[v]','-c:v','libx264','-preset',PRESET,'-pix_fmt','yuv420p','-t','3.5','-y',endCard]);
    segments.push(endCard);

    update('processing', 78, 'Applying ' + transition + ' transitions...');
    const finalVideo = await applyTransitions(segments, transition, w, h, workDir, PRESET, FPS, DUR);

    update('processing', 88, 'Adding logo...');
    let videoWithLogo = finalVideo;
    if (logoFile && fs.existsSync(logoFile)) {
      const logoOut = path.join(workDir, 'with_logo.mp4');
      const ls = Math.round(w*0.12), pad = Math.round(w*0.03);
      await runFFmpeg(['-i',finalVideo,'-i',logoFile,'-filter_complex','[1:v]scale='+ls+':-1[logo];[0:v][logo]overlay=W-w-'+pad+':H-h-'+pad+'[v]','-map','[v]','-c:v','libx264','-preset',PRESET,'-pix_fmt','yuv420p','-y',logoOut]);
      videoWithLogo = logoOut;
    }

    update('processing', 94, 'Adding background music...');
    const musicFile = path.join(MUSIC_DIR, getMusicFile(musicMood));
    if (fs.existsSync(musicFile)) {
      await runFFmpeg(['-i',videoWithLogo,'-i',musicFile,'-filter_complex','[1:a]volume=0.4[a]','-map','0:v','-map','[a]','-c:v','copy','-c:a','aac','-shortest','-y',outputPath]);
    } else {
      fs.copyFileSync(videoWithLogo, outputPath);
    }
    jobs.set(jobId, { ...jobs.get(jobId), status: 'complete', progress: 100, message: 'Your video is ready!', outputPath });
    setTimeout(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e){} }, 3600000);
  } catch (err) {
    console.error('Processing error:', err.message);
    jobs.set(jobId, { status: 'error', progress: 0, message: err.message });
  }
}

async function applyTransitions(segments, transition, w, h, workDir, preset, fps, dur) {
  if (transition === 'Cut') {
    // Hard cut — simple concat no transitions
    const concatList = path.join(workDir, 'concat.txt');
    fs.writeFileSync(concatList, segments.map(s => "file '" + s + "'").join('\n'));
    const out = path.join(workDir, 'transitions.mp4');
    await runFFmpeg(['-f','concat','-safe','0','-i',concatList,'-c:v','libx264','-preset',preset,'-pix_fmt','yuv420p','-y',out]);
    return out;
  }

  // Fade or Dissolve — use xfade filter between each pair
  const xfadeType = transition === 'Dissolve' ? 'dissolve' : 'fade';
  const fadeDur = transition === 'Dissolve' ? 0.6 : 0.4;
  const segDur = dur + 0.5;

  if (segments.length === 1) return segments[0];

  // Build xfade chain for all segments
  let inputs = segments.map(s => '-i ' + s).join(' ').split(' ');
  let filterParts = [];
  let lastLabel = '[0:v]';

  for (let i = 0; i < segments.length - 1; i++) {
    const nextLabel = '[v' + i + ']';
    const offset = Math.max(0.1, (i + 1) * segDur - fadeDur);
    if (i === 0) {
      filterParts.push('[0:v][1:v]xfade=transition=' + xfadeType + ':duration=' + fadeDur + ':offset=' + offset.toFixed(2) + nextLabel);
    } else {
      filterParts.push(lastLabel + '[' + (i+1) + ':v]xfade=transition=' + xfadeType + ':duration=' + fadeDur + ':offset=' + offset.toFixed(2) + nextLabel);
    }
    lastLabel = nextLabel;
  }

  const filterComplex = filterParts.join(';');
  const out = path.join(workDir, 'transitions.mp4');

  let args = [];
  segments.forEach(s => { args.push('-i', s); });
  args = args.concat(['-filter_complex', filterComplex, '-map', lastLabel, '-c:v', 'libx264', '-preset', preset, '-pix_fmt', 'yuv420p', '-y', out]);
  await runFFmpeg(args);
  return out;
}

function getTextOverlay(i, address, price, beds, baths, sqft, tagline, w, h) {
  const fs2 = Math.round(w*0.04), pad = Math.round(w*0.05);
  const fade = "alpha='if(lt(t,0.5),t/0.5,1)'";
  if (i===0 && (address||price)) {
    const l1=(address||'').replace(/[':]/g,''), l2=(price||'').replace(/[':]/g,'');
    return "drawtext=text='"+l1+"':fontsize="+fs2+":fontcolor=white:x="+pad+":y=h-"+(pad*4)+":"+fade+":shadowcolor=black:shadowx=2:shadowy=2,drawtext=text='"+l2+"':fontsize="+(Math.round(fs2*1.3))+":fontcolor=white:x="+pad+":y=h-"+(pad*2)+":"+fade+":shadowcolor=black:shadowx=2:shadowy=2";
  }
  if (i===1 && (beds||baths||sqft)) {
    const d=((beds||'')+'bd / '+(baths||'')+'ba  '+(sqft||'')).replace(/[':]/g,'');
    return "drawtext=text='"+d+"':fontsize="+fs2+":fontcolor=white:x="+pad+":y=h-"+(pad*2)+":"+fade+":shadowcolor=black:shadowx=2:shadowy=2";
  }
  if (i===2 && tagline) {
    const t=(tagline||'').replace(/[':]/g,'');
    return "drawtext=text='"+t+"':fontsize="+(Math.round(fs2*1.2))+":fontcolor=white:x=(w-tw)/2:y=h-"+(pad*2)+":"+fade+":shadowcolor=black:shadowx=2:shadowy=2";
  }
  return null;
}
function buildEndCard(agentName, agentPhone, w, h) {
  const fs2=Math.round(w*0.04), pad=Math.round(w*0.05);
  const n=(agentName||'').replace(/[':]/g,''), p=(agentPhone||'').replace(/[':]/g,'');
  return "[0:v]drawtext=text='"+n+"':fontsize="+(Math.round(fs2*1.2))+":fontcolor=white:x=(w-tw)/2:y=h/2-"+pad+",drawtext=text='"+p+"':fontsize="+fs2+":fontcolor=#F47920:x=(w-tw)/2:y=h/2,drawtext=text='Powered by Quality Capture Visuals':fontsize="+(Math.round(fs2*0.7))+":fontcolor=#aaaaaa:x=(w-tw)/2:y=h/2+"+pad+",drawtext=text='qualitycapturevisuals.com':fontsize="+(Math.round(fs2*0.7))+":fontcolor=#aaaaaa:x=(w-tw)/2:y=h/2+"+(pad*2)+"[v]";
}
function getMusicFile(mood) {
  return { 'Cinematic':'cinematic.mp3','Upbeat':'upbeat.mp3','Elegant':'elegant.mp3','Dramatic':'dramatic.mp3' }[mood] || 'cinematic.mp3';
}
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', d => stderr += d.toString());
    ff.on('close', code => { if (code===0) resolve(); else reject(new Error('FFmpeg: ' + stderr.slice(-400))); });
  });
}
app.listen(PORT, () => console.log('QCV Video Creator on port ' + PORT));