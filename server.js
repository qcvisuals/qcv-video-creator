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

const HIGGSFIELD_KEY = '2f155db1e04d8929ce01ac26402d525fc80c96fbac0cbebc274c3d2acffc4d48';
const jobs = {};

async function uploadAsset(filePath, mimeType, assetType) {
  const fd = new FormData();
  fd.append('file', fs.createReadStream(filePath), { contentType: mimeType, filename: assetType === 'audio' ? 'audio.webm' : 'photo.jpg' });
  const r = await fetch('https://cloud.higgsfield.ai/api/v1/assets/upload', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + HIGGSFIELD_KEY, ...fd.getHeaders() },
    body: fd
  });
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch(e) { throw new Error('Upload parse error: ' + text.slice(0,200)); }
  if (!d.id && !d.asset_id) throw new Error('Upload failed: ' + JSON.stringify(d).slice(0,200));
  return d.id || d.asset_id;
}

async function generateAvatar(imageAssetId, audioAssetId) {
  const body = { model: 'kling-avatar', image_asset_id: imageAssetId, audio_asset_id: audioAssetId };
  const r = await fetch('https://cloud.higgsfield.ai/api/v1/generate', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + HIGGSFIELD_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let d; try { d = JSON.parse(text); } catch(e) { throw new Error('Generate parse error: ' + text.slice(0,200)); }
  if (!d.id) throw new Error('Generate failed: ' + JSON.stringify(d).slice(0,300));
  return d.id;
}

async function pollGeneration(genId, jobId) {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < 420000) {
    await new Promise(r => setTimeout(r, 8000));
    attempt++;
    try {
      const r = await fetch('https://cloud.higgsfield.ai/api/v1/generate/' + genId, {
        headers: { 'Authorization': 'Bearer ' + HIGGSFIELD_KEY }
      });
      const d = await r.json();
      const pct = Math.min(75 + attempt * 2, 92);
      jobs[jobId] = { status: 'processing', progress: pct, message: 'Rendering avatar... (' + Math.round((Date.now()-start)/1000) + 's)' };
      if (d.status === 'completed' && d.output_url) return d.output_url;
      if (d.status === 'failed') throw new Error('Generation failed: ' + (d.error || JSON.stringify(d)));
    } catch(e) {
      if (e.message.includes('Generation failed')) throw e;
    }
  }
  throw new Error('Timed out after 7 minutes');
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

    jobs[jobId] = { status: 'processing', progress: 30, message: 'Uploading your photo...' };
    const imageId = await uploadAsset(photo.path, photo.mimetype || 'image/jpeg', 'image');

    jobs[jobId] = { status: 'processing', progress: 50, message: 'Uploading your voice recording...' };
    const audioId = await uploadAsset(voice.path, voice.mimetype || 'audio/webm', 'audio');

    jobs[jobId] = { status: 'processing', progress: 65, message: 'Sending to Higgsfield...' };
    const genId = await generateAvatar(imageId, audioId);

    jobs[jobId] = { status: 'processing', progress: 75, message: 'Generating your avatar — 2-4 minutes...' };
    const videoUrl = await pollGeneration(genId, jobId);

    jobs[jobId] = { status: 'processing', progress: 93, message: 'Downloading your video...' };
    const videoRes = await fetch(videoUrl);
    const buf = Buffer.from(await videoRes.arrayBuffer());
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

app.listen(PORT, () => console.log('QCV Avatar Creator running on port ' + PORT));
