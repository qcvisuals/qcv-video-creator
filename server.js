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
const PORT = process.env.PORT || 3000;
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
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.static(path.join(__dirname, 'public')));
app.post('/api/generate-video', (req, res, next) => { req.jobId = uuidv4(); next(); },
  upload.fields([{ name: 'photos', maxCount: 10 }, { name: 'logo', maxCount: 1 }]),
  async (req, res) => {
    try {
      const jobId = req.jobId;
      const { address, price, beds, baths, sqft, tagline, agentName, agentPhone, musicMood, videoFormat, transition } = req.body;
      const photos = (req.files['photos'] || []).map(f => f.path);
      const logoFile = req.files['logo'] ? req.files['logo'][0].path : null;
      if (photos.length < 1) return res.status(400).json({ error: 'At least 1 photo required' });
      jobs.set(jobId, { status: 'processing', progress: 0, message: 'Starting your video...' });
      res.json({ jobId });
      processVideo({ jobId, photos, logoFile, address, price, beds, baths, sqft, tagline, agentName, agentPhone, musicMood, videoFormat, transition });
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
    update('processing', 5, 'Getting everything ready...');
    const segments = [];
    for (let i = 0; i < photos.length; i++) {
      const pct = Math.round(5 + (i / photos.length) * 55);
      update('processing', pct, 'Processing photo ' + (i+1) + ' of ' + photos.length + ' — hang tight!');
      const segOut = path.join(workDir, 'seg_' + i + '.mp4');
      const zoompan = 'zoompan=z=\'min(zoom+0.0006,1.06)\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=' + FRAMES + ':s=' + w + 'x' + h + ':fps=' + FPS;
      let filter = '[0:v]scale=' + (w*2) + ':' + (h*2) + ',' + zoompan;
      const txt = getTextOverlay(i, address, price, beds, baths, sqft, tagline, w, h);
      if (txt) filter += ',' + txt;
      filter += '[v]';
      await runFFmpeg(['-loop','1','-t',String(DUR),'-i',photos[i],'-filter_complex',filter,'-map','[v]','-c:v','libx264','-preset',PRESET,'-pix_fmt','yuv420p','-r',String(FPS),'-t',String(DUR),'-y',segOut]);
      segments.push(segOut);
    }
    update('processing', 65, 'Building your end card...');
    const endCard = path.join(workDir, 'endcard.mp4');
    const ec = buildEndCard(agentName, agentPhone, w, h);
    await runFFmpeg(['-f','lavfi','-i','color=c=black:s='+w+'x'+h+':d=3:r='+FPS,'-filter_complex',ec,'-map','[v]','-c:v','libx264','-preset',PRESET,'-pix_fmt','yuv420p','-t','3','-y',endCard]);
    segments.push(endCard);
    update('processing', 72, 'Joining all clips together...');
    const concatList = path.join(workDir, 'concat.txt');
    fs.writeFileSync(concatList, segments.map(s => "file '" + s + "'").join('\n'));
    const concatOut = path.join(workDir, 'concat.mp4');
    await runFFmpeg(['-f','concat','-safe','0','-i',concatList,'-c:v','libx264','-preset',PRESET,'-pix_fmt','yuv420p','-y',concatOut]);
    update('processing', 82, 'Adding your logo...');
    let videoWithLogo = concatOut;
    if (logoFile && fs.existsSync(logoFile)) {
      const logoOut = path.join(workDir, 'with_logo.mp4');
      const ls = Math.round(w*0.12), pad = Math.round(w*0.03);
      await runFFmpeg(['-i',concatOut,'-i',logoFile,'-filter_complex','[1:v]scale='+ls+':-1[logo];[0:v][logo]overlay=W-w-'+pad+':H-h-'+pad+'[v]','-map','[v]','-c:v','libx264','-preset',PRESET,'-pix_fmt','yuv420p','-y',logoOut]);
      videoWithLogo = logoOut;
    }
    update('processing', 92, 'Adding background music...');
    const musicFile = path.join(MUSIC_DIR, getMusicFile(musicMood));
    if (fs.existsSync(musicFile)) {
      await runFFmpeg(['-i',videoWithLogo,'-i',musicFile,'-filter_complex','[1:a]volume=0.4[a]','-map','0:v','-map','[a]','-c:v','copy','-c:a','aac','-shortest','-y',outputPath]);
    } else {
      fs.copyFileSync(videoWithLogo, outputPath);
    }
    jobs.set(jobId, { ...jobs.get(jobId), status: 'complete', progress: 100, message: 'Your video is ready!', outputPath });
    setTimeout(() => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch(e){} }, 3600000);
  } catch (err) {
    console.error(err);
    jobs.set(jobId, { status: 'error', progress: 0, message: 'Something went wrong: ' + err.message });
  }
}
function getTextOverlay(i, address, price, beds, baths, sqft, tagline, w, h) {
  const fs2 = Math.round(w*0.04), pad = Math.round(w*0.05);
  const fade = "alpha='if(lt(t,0.5),t/0.5,1)'";
  if (i===0 && (address||price)) {
    const l1=(address||'').replace(/'/g,''), l2=(price||'').replace(/'/g,'');
    return "drawtext=text='"+l1+"':fontsize="+fs2+":fontcolor=white:x="+pad+":y=h-"+(pad*4)+":"+fade+":shadowcolor=black:shadowx=2:shadowy=2,drawtext=text='"+l2+"':fontsize="+(Math.round(fs2*1.3))+":fontcolor=white:x="+pad+":y=h-"+(pad*2)+":"+fade+":shadowcolor=black:shadowx=2:shadowy=2";
  }
  if (i===1 && (beds||baths||sqft)) {
    const d=((beds||'')+'bd / '+(baths||'')+'ba  '+(sqft||'')).replace(/'/g,'');
    return "drawtext=text='"+d+"':fontsize="+fs2+":fontcolor=white:x="+pad+":y=h-"+(pad*2)+":"+fade+":shadowcolor=black:shadowx=2:shadowy=2";
  }
  if (i===2 && tagline) {
    const t=(tagline||'').replace(/'/g,'');
    return "drawtext=text='"+t+"':fontsize="+(Math.round(fs2*1.2))+":fontcolor=white:x=(w-tw)/2:y=h-"+(pad*2)+":"+fade+":shadowcolor=black:shadowx=2:shadowy=2";
  }
  return null;
}
function buildEndCard(agentName, agentPhone, w, h) {
  const fs2=Math.round(w*0.04), pad=Math.round(w*0.05);
  const n=(agentName||'').replace(/'/g,''), p=(agentPhone||'').replace(/'/g,'');
  return "[0:v]drawtext=text='"+n+"':fontsize="+(Math.round(fs2*1.2))+":fontcolor=white:x=(w-tw)/2:y=h/2-"+pad+",drawtext=text='"+p+"':fontsize="+fs2+":fontcolor=#F47920:x=(w-tw)/2:y=h/2,drawtext=text='Powered by Quality Capture Visuals':fontsize="+(Math.round(fs2*0.7))+":fontcolor=#aaaaaa:x=(w-tw)/2:y=h/2+"+pad+",drawtext=text='qualitycapturevisuals.com':fontsize="+(Math.round(fs2*0.7))+":fontcolor=#aaaaaa:x=(w-tw)/2:y=h/2+"+(pad*2)+"[v]";
}
function getMusicFile(mood) {
  const m = { 'Cinematic':'cinematic.mp3','Upbeat':'upbeat.mp3','Elegant':'elegant.mp3','Dramatic':'dramatic.mp3' };
  return m[mood] || 'cinematic.mp3';
}
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', d => stderr += d.toString());
    ff.on('close', code => { if (code===0) resolve(); else reject(new Error('FFmpeg error: ' + stderr.slice(-300))); });
  });
}
app.listen(PORT, () => console.log('QCV Video Creator on port ' + PORT));