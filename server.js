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
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9._]/g, '_'))
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
    const DUR = 3.0;
    const FPS = 30;
    const FRAMES = Math.round(DUR * FPS);
    const PRESET = 'ultrafast';

    // Phase 1: Render each photo as a segment with Ken Burns + text overlay
    const segments = [];
    for (let i = 0; i < photos.length; i++) {
      const pct = Math.round(30 + (i / photos.length) * 35);
      update('processing', pct, 'Rendering photo ' + (i + 1) + ' of ' + photos.length + '...');
      const segOut = path.join(workDir, 'seg_' + String(i).padStart(3, '0') + '.mp4');
      const zoompan = 'zoompan=z=\'min(zoom+0.0006,1.06)\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=' + FRAMES + ':s=' + w + 'x' + h + ':fps=' + FPS;
      let vf = 'scale=' + (w * 2) + ':' + (h * 2) + ',' + zoompan;
      const txt = getTextOverlay(i, address, price, beds, baths, sqft, tagline, w, h);
      if (txt) vf += ',' + txt;
      await runFFmpeg([
        '-loop', '1', '-t', String(DUR), '-i', photos[i],
        '-vf', vf,
        '-c:v', 'libx264', '-preset', PRESET, '-pix_fmt', 'yuv420p',
        '-r', String(FPS), '-t', String(DUR), '-an', '-y', segOut
      ]);
      segments.push(segOut);
    }

    // Phase 2: End card
    update('processing', 68, 'Building end card...');
    const endCard = path.join(workDir, 'endcard.mp4');
    await runFFmpeg([
      '-f', 'lavfi', '-i', 'color=c=black:s=' + w + 'x' + h + ':d=3:r=' + FPS,
      '-vf', buildEndCard(agentName, agentPhone, w, h),
      '-c:v', 'libx264', '-preset', PRESET, '-pix_fmt', 'yuv420p',
      '-t', '3', '-an', '-y', endCard
    ]);
    segments.push(endCard);

    // Phase 3: Apply transitions by processing pairs sequentially
    update('processing', 74, 'Applying ' + transition + ' transitions...');
    const finalVideo = await applyTransitionsPairwise(segments, transition, workDir, PRESET, FPS, DUR);

    // Phase 4: Add logo watermark
    update('processing', 86, 'Adding logo...');
    let videoWithLogo = finalVideo;
    if (logoFile && fs.existsSync(logoFile)) {
      const logoOut = path.join(workDir, 'with_logo.mp4');
      const ls = Math.round(w * 0.12);
      const pad = Math.round(w * 0.03);
      await runFFmpeg([
        '-i', finalVideo, '-i', logoFile,
        '-filter_complex', '[1:v]scale=' + ls + ':-1[logo];[0:v][logo]overlay=W-w-' + pad + ':H-h-' + pad,
        '-c:v', 'libx264', '-preset', PRESET, '-pix_fmt', 'yuv420p', '-an', '-y', logoOut
      ]);
      videoWithLogo = logoOut;
    }

    // Phase 5: Add music
    update('processing', 93, 'Adding music...');
    const musicFile = path.join(MUSIC_DIR, getMusicFile(musicMood));
    if (fs.existsSync(musicFile)) {
      await runFFmpeg([
        '-i', videoWithLogo, '-i', musicFile,
        '-filter_complex', '[1:a]volume=0.4[a]',
        '-map', '0:v', '-map', '[a]',
        '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-y', outputPath
      ]);
    } else {
      fs.copyFileSync(videoWithLogo, outputPath);
    }

    jobs.set(jobId, { ...jobs.get(jobId), status: 'complete', progress: 100, message: 'Your video is ready!', outputPath });
    setTimeout(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {} }, 3600000);
  } catch (err) {
    console.error('Processing error:', err.message);
    jobs.set(jobId, { status: 'error', progress: 0, message: err.message.slice(0, 200) });
  }
}

// Apply transitions pairwise — merge clip A + clip B, then result + clip C, etc.
async function applyTransitionsPairwise(segments, transition, workDir, preset, fps, dur) {
  if (transition === 'Cut' || segments.length === 1) {
    // Hard cut — simple concat
    const listFile = path.join(workDir, 'cutlist.txt');
    fs.writeFileSync(listFile, segments.map(s => "file '" + s + "'").join('\n'));
    const out = path.join(workDir, 'cut_final.mp4');
    await runFFmpeg(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', out]);
    return out;
  }

  // For Fade and Slide/Zoom: process pairs one at a time
  const xfadeMap = {
    'Fade': { type: 'fade', dur: 0.5 },
    'Slide': { type: 'slideleft', dur: 0.5 },
    'Zoom': { type: 'zoomin', dur: 0.5 }
  };
  const xf = xfadeMap[transition] || xfadeMap['Fade'];
  const fadeDur = xf.dur;
  const clipDur = dur;

  let current = segments[0];
  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    const merged = path.join(workDir, 'merge_' + i + '.mp4');
    // offset = total duration of current video minus fade overlap
    // We know each original segment is clipDur seconds, end card is 3s
    const currentDur = (i === 1) ? clipDur : clipDur; // approximate
    const offset = Math.max(0.1, (i * clipDur) - (fadeDur * i));
    await runFFmpeg([
      '-i', current,
      '-i', next,
      '-filter_complex',
      '[0:v][1:v]xfade=transition=' + xf.type + ':duration=' + fadeDur + ':offset=' + offset.toFixed(3) + '[v]',
      '-map', '[v]',
      '-c:v', 'libx264', '-preset', preset, '-pix_fmt', 'yuv420p', '-r', String(fps), '-an', '-y', merged
    ]);
    current = merged;
  }
  return current;
}

function getTextOverlay(i, address, price, beds, baths, sqft, tagline, w, h) {
  const fs2 = Math.round(w * 0.04);
  const pad = Math.round(w * 0.05);
  const fade = "alpha='if(lt(t,0.5),t/0.5,1)'";
  const clean = s => (s || '').replace(/[':=\\]/g, '');
  if (i === 0 && (address || price)) {
    return "drawtext=text='" + clean(address) + "':fontsize=" + fs2 + ":fontcolor=white:x=" + pad + ":y=h-" + (pad * 4) + ":" + fade + ":shadowcolor=black:shadowx=2:shadowy=2," +
           "drawtext=text='" + clean(price) + "':fontsize=" + Math.round(fs2 * 1.3) + ":fontcolor=white:x=" + pad + ":y=h-" + (pad * 2) + ":" + fade + ":shadowcolor=black:shadowx=2:shadowy=2";
  }
  if (i === 1 && (beds || baths || sqft)) {
    return "drawtext=text='" + clean(beds) + "bd / " + clean(baths) + "ba  " + clean(sqft) + "':fontsize=" + fs2 + ":fontcolor=white:x=" + pad + ":y=h-" + (pad * 2) + ":" + fade + ":shadowcolor=black:shadowx=2:shadowy=2";
  }
  if (i === 2 && tagline) {
    return "drawtext=text='" + clean(tagline) + "':fontsize=" + Math.round(fs2 * 1.2) + ":fontcolor=white:x=(w-tw)/2:y=h-" + (pad * 2) + ":" + fade + ":shadowcolor=black:shadowx=2:shadowy=2";
  }
  return null;
}

function buildEndCard(agentName, agentPhone, w, h) {
  const fs2 = Math.round(w * 0.04);
  const pad = Math.round(w * 0.05);
  const clean = s => (s || '').replace(/[':=\\]/g, '');
  return "drawtext=text='" + clean(agentName) + "':fontsize=" + Math.round(fs2 * 1.2) + ":fontcolor=white:x=(w-tw)/2:y=h/2-" + pad + "," +
         "drawtext=text='" + clean(agentPhone) + "':fontsize=" + fs2 + ":fontcolor=#F47920:x=(w-tw)/2:y=h/2," +
         "drawtext=text='Powered by Quality Capture Visuals':fontsize=" + Math.round(fs2 * 0.7) + ":fontcolor=#aaaaaa:x=(w-tw)/2:y=h/2+" + pad + "," +
         "drawtext=text='qualitycapturevisuals.com':fontsize=" + Math.round(fs2 * 0.7) + ":fontcolor=#aaaaaa:x=(w-tw)/2:y=h/2+" + (pad * 2);
}

function getMusicFile(mood) {
  return ({ 'Cinematic': 'cinematic.mp3', 'Upbeat': 'upbeat.mp3', 'Elegant': 'elegant.mp3', 'Dramatic': 'dramatic.mp3' })[mood] || 'cinematic.mp3';
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', ...args]);
    let stderr = '';
    ff.stderr.on('data', d => stderr += d.toString());
    ff.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('FFmpeg exit ' + code + ': ' + stderr.slice(-500)));
    });
  });
}

app.listen(PORT, () => console.log('QCV Video Creator running on port ' + PORT));