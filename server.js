const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const fetch = (...args) => import('node-fetch').then(({default:f}) => f(...args));
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.static(path.join(__dirname, 'public')));

const HEYGEN_KEY = 'sk_V2_hgu_kJjvg9V1Rto_jBsGXV0qejoFst2XD8L8cIJBQnf4yNGC';
const jobs = {};

async function heygenRequest(endpoint, method, body) {
  const opts = {
    method,
    headers: { 'X-Api-Key': HEYGEN_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch('https://api.heygen.com' + endpoint, opts);
  const text = await r.text();
  try { return JSON.parse(text); } catch(e) { throw new Error('HeyGen parse error: ' + text.slice(0,300)); }
}

async function uploadVoice(voicePath, mimeType) {
  const fd = new FormData();
  fd.append('file', fs.createReadStream(voicePath), { contentType: mimeType || 'audio/webm', filename: 'voice.webm' });
  const r = await fetch('https://api.heygen.com/v1/asset', {
    method: 'POST',
    headers: { 'X-Api-Key': HEYGEN_KEY, ...fd.getHeaders() },
    body: fd
  });
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch(e) { throw new Error('Voice upload parse: ' + text.slice(0,200)); }
  if (!d.data?.id) throw new Error('Voice upload failed: ' + JSON.stringify(d).slice(0,200));
  return d.data.id;
}

async function uploadPhoto(photoPath, mimeType) {
  const fd = new FormData();
  fd.append('file', fs.createReadStream(photoPath), { contentType: mimeType || 'image/jpeg', filename: 'photo.jpg' });
  const r = await fetch('https://api.heygen.com/v1/asset', {
    method: 'POST',
    headers: { 'X-Api-Key': HEYGEN_KEY, ...fd.getHeaders() },
    body: fd
  });
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch(e) { throw new Error('Photo upload parse: ' + text.slice(0,200)); }
  if (!d.data?.id) throw new Error('Photo upload failed: ' + JSON.stringify(d).slice(0,200));
  return d.data.id;
}

async function createTalkingPhoto(photoAssetId, audioAssetId) {
  const d = await heygenRequest('/v1/talking_photo', 'POST', {
    talking_photo_id: photoAssetId,
    audio_type: 'audio',
    audio_asset_id: audioAssetId,
    talking_style: 'expressive'
  });
  if (!d.data?.video_id) throw new Error('Talking photo failed: ' + JSON.stringify(d).slice(0,300));
  return d.data.video_id;
}

async function pollVideo(videoId, jobId) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < 360000) {
    await new Promise(r => setTimeout(r, 6000));
    attempt++;
    const d = await heygenRequest('/v1/video_status.get?video_id=' + videoId, 'GET');
    const status = d.data?.status;
    const pct = Math.min(70 + attempt * 3, 93);
    jobs[jobId] = { status: 'processing', progress: pct, message: 'Rendering avatar... (' + Math.round((Date.now()-start)/1000) + 's)' };
    if (status === 'completed' && d.data?.video_url) return d.data.video_url;
    if (status === 'failed') throw new Error('Video failed: ' + (d.data?.error || JSON.stringify(d).slice(0,200)));
  }
  throw new Error('Timed out after 6 minutes');
}

app.post('/generate', upload.fields([{name:'photo',maxCount:1},{name:'bgPhoto',maxCount:1},{name:'voice',maxCount:1}]), async (req, res) => {
  const jobId = uuidv4();
  jobs[jobId] = { status: 'processing', progress: 10, message: 'Starting...' };
  res.json({ jobId });
  const toClean = [];
  try {
    const photo = req.files['photo']?.[0];
    const voice = req.files['voice']?.[0];
    if (!photo) throw new Error('No photo uploaded');
    if (!voice) throw new Error('No voice recording uploaded');
    toClean.push(photo.path, voice.path);
    if (req.files['bgPhoto']?.[0]) toClean.push(req.files['bgPhoto'][0].path);

    jobs[jobId] = { status: 'processing', progress: 25, message: 'Uploading your photo to HeyGen...' };
    const photoAssetId = await uploadPhoto(photo.path, photo.mimetype);

    jobs[jobId] = { status: 'processing', progress: 45, message: 'Uploading your voice recording...' };
    const audioAssetId = await uploadVoice(voice.path, voice.mimetype);

    jobs[jobId] = { status: 'processing', progress: 60, message: 'Generating your talking avatar...' };
    const videoId = await createTalkingPhoto(photoAssetId, audioAssetId);

    jobs[jobId] = { status: 'processing', progress: 70, message: 'Rendering — 1-3 minutes...' };
    const videoUrl = await pollVideo(videoId, jobId);

    jobs[jobId] = { status: 'processing', progress: 94, message: 'Downloading your video...' };
    const buf = Buffer.from(await fetch(videoUrl).then(r => r.arrayBuffer()));
    const out = '/tmp/avatar-' + jobId + '.mp4';
    fs.writeFileSync(out, buf);

    toClean.forEach(f => { try{fs.unlinkSync(f);}catch(e){} });
    jobs[jobId] = { status: 'done', progress: 100, message: 'Your avatar video is ready!', outputPath: out };

  } catch(err) {
    console.error('Error:', err.message);
    jobs[jobId] = { status: 'error', progress: 0, error: err.message };
    toClean.forEach(f => { try{fs.unlinkSync(f);}catch(e){} });
  }
});

app.get('/progress/:id', (req, res) => {
  const j = jobs[req.params.id];
  if (!j) return res.status(404).json({ error: 'Not found' });
  res.json(j);
});

app.get('/download/:id', (req, res) => {
  const j = jobs[req.params.id];
  if (!j || j.status !== 'done') return res.status(404).json({ error: 'Not ready' });
  res.download(j.outputPath, 'qcv-avatar-video.mp4');
});

app.listen(PORT, () => console.log('QCV HeyGen Avatar Creator running on port ' + PORT));
