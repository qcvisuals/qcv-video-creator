const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const fetch = (...args) => import('node-fetch').then(({default:f}) => f(...args));
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/uploads/' });
app.use(express.static(path.join(__dirname, 'public')));

const ELEVENLABS_KEY = 'sk_d09df28c46e9422b1fd3ad6729e3a3580a38f1b5ebc1bc3f';
const HIGGSFIELD_KEY = '2f155db1e04d8929ce01ac26402d525fc80c96fbac0cbebc274c3d2acffc4d48';
const jobs = {};

async function cloneVoice(voicePath, agentName) {
  const fd = new FormData();
  fd.append('name', agentName || 'QCV Agent Voice');
  fd.append('files', fs.createReadStream(voicePath));
  const r = await fetch('https://api.elevenlabs.io/v1/voices/add', {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY, ...fd.getHeaders() },
    body: fd
  });
  const d = await r.json();
  if (!d.voice_id) throw new Error('Voice clone failed: ' + JSON.stringify(d).slice(0,200));
  return d.voice_id;
}

async function textToSpeech(voiceId, text) {
  const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.8 } })
  });
  if (!r.ok) throw new Error('TTS failed: ' + r.status);
  const buf = await r.buffer();
  const audioPath = '/tmp/speech-' + uuidv4() + '.mp3';
  fs.writeFileSync(audioPath, buf);
  return audioPath;
}

async function deleteVoice(voiceId) {
  try { await fetch('https://api.elevenlabs.io/v1/voices/' + voiceId, { method: 'DELETE', headers: { 'xi-api-key': ELEVENLABS_KEY } }); } catch(e) {}
}

async function uploadAsset(filePath, mimeType) {
  const fd = new FormData();
  fd.append('file', fs.createReadStream(filePath), { contentType: mimeType });
  const r = await fetch('https://cloud.higgsfield.ai/api/v1/assets/upload', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + HIGGSFIELD_KEY, ...fd.getHeaders() },
    body: fd
  });
  const d = await r.json();
  if (!d.id) throw new Error('Asset upload failed: ' + JSON.stringify(d).slice(0,200));
  return d.id;
}

async function generateAvatar(imageAssetId, audioAssetId) {
  const r = await fetch('https://cloud.higgsfield.ai/api/v1/generate', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + HIGGSFIELD_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'kling-avatar', image_asset_id: imageAssetId, audio_asset_id: audioAssetId, duration: 30 })
  });
  const d = await r.json();
  if (!d.id) throw new Error('Avatar generation failed: ' + JSON.stringify(d).slice(0,200));
  return d.id;
}

async function pollGeneration(genId, maxWait = 300000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await new Promise(r => setTimeout(r, 5000));
    const r = await fetch('https://cloud.higgsfield.ai/api/v1/generate/' + genId, {
      headers: { 'Authorization': 'Bearer ' + HIGGSFIELD_KEY }
    });
    const d = await r.json();
    if (d.status === 'completed' && d.output_url) return d.output_url;
    if (d.status === 'failed') throw new Error('Generation failed: ' + (d.error || 'unknown'));
  }
  throw new Error('Generation timed out');
}

app.post('/generate', upload.fields([{name:'photo',maxCount:1},{name:'bgPhoto',maxCount:1},{name:'voice',maxCount:1}]), async (req, res) => {
  const jobId = uuidv4();
  jobs[jobId] = { status: 'processing', progress: 10, message: 'Starting...' };
  res.json({ jobId });

  let voiceId = null;
  const toClean = [];

  try {
    const photo = req.files['photo']?.[0];
    const bgPhoto = req.files['bgPhoto']?.[0];
    const voice = req.files['voice']?.[0];
    if (!photo || !voice) throw new Error('Missing photo or voice file');

    const { script, agentName, agentPhone, brokerage, address, cityState, price, beds, baths, sqft, occasion, frame, bgColor, textColor, accentColor, aspectRatio } = req.body;

    toClean.push(photo.path, voice.path);
    if (bgPhoto) toClean.push(bgPhoto.path);

    jobs[jobId] = { status: 'processing', progress: 20, message: 'Cloning your voice...' };
    voiceId = await cloneVoice(voice.path, agentName);

    jobs[jobId] = { status: 'processing', progress: 35, message: 'Generating speech from script...' };
    const audioPath = await textToSpeech(voiceId, script);
    toClean.push(audioPath);

    jobs[jobId] = { status: 'processing', progress: 50, message: 'Uploading assets to Higgsfield...' };
    const [imageAssetId, audioAssetId] = await Promise.all([
      uploadAsset(photo.path, photo.mimetype),
      uploadAsset(audioPath, 'audio/mpeg')
    ]);

    jobs[jobId] = { status: 'processing', progress: 65, message: 'Generating your avatar video...' };
    const genId = await generateAvatar(imageAssetId, audioAssetId);

    jobs[jobId] = { status: 'processing', progress: 75, message: 'Rendering avatar — this takes 2-4 minutes...' };
    const videoUrl = await pollGeneration(genId);

    jobs[jobId] = { status: 'processing', progress: 90, message: 'Downloading and finalizing video...' };
    const videoRes = await fetch(videoUrl);
    const videoBuf = await videoRes.buffer();
    const outputPath = '/tmp/avatar-' + jobId + '.mp4';
    fs.writeFileSync(outputPath, videoBuf);

    toClean.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    if (voiceId) await deleteVoice(voiceId);

    jobs[jobId] = { status: 'done', progress: 100, message: 'Your avatar video is ready!', outputPath };

  } catch (err) {
    console.error('Avatar error:', err.message);
    jobs[jobId] = { status: 'error', progress: 0, error: err.message };
    toClean.forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    if (voiceId) await deleteVoice(voiceId);
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
