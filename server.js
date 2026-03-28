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
  fd.append('description', 'QCV real estate agent voice clone');
  fd.append('files', fs.createReadStream(voicePath));
  fd.append('remove_background_noise', 'false');
  const r = await fetch('https://api.elevenlabs.io/v1/voices/add', {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY, ...fd.getHeaders() },
    body: fd
  });
  const text = await r.text();
  let d;
  try { d = JSON.parse(text); } catch(e) { throw new Error('Voice clone parse error: ' + text.slice(0,200)); }
  if (!d.voice_id) throw new Error('Voice clone failed: ' + JSON.stringify(d).slice(0,200));
  return d.voice_id;
}

async function textToSpeech(voiceId, text) {
  const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voiceId, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.8 } })
  });
  if (!r.ok) { const t = await r.text(); throw new Error('TTS failed ' + r.status + ': ' + t.slice(0,200)); }
  const buf = await r.buffer();
  const audioPath = '/tmp/speech-' + uuidv4() + '.mp3';
  fs.writeFileSync(audioPath, buf);
  return audioPath;
}

async function deleteVoice(voiceId) {
  try { await fetch('https://api.elevenlabs.io/v1/voices/' + voiceId, { method: 'DELETE', headers: { 'xi-api-key': ELEVENLABS_KEY } }); } catch(e) {}
}

async function uploadToHiggsfield(filePath, mimeType) {
  const createRes = await fetch('https://cloud.higgsfield.ai/api/v1/assets', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + HIGGSFIELD_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: mimeType.startsWith('audio') ? 'audio' : 'image' })
  });
  const createData = await createRes.json();
  if (!createData.id) throw new Error('Asset create failed: ' + JSON.stringify(createData).slice(0,200));
  const fd = new FormData();
  fd.append('file', fs.createReadStream(filePath), { contentType: mimeType });
  await fetch('https://cloud.higgsfield.ai/api/v1/assets/' + createData.id + '/upload', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + HIGGSFIELD_KEY, ...fd.getHeaders() },
    body: fd
  });
  return createData.id;
}

async function generateAvatar(imageAssetId, audioAssetId) {
  const r = await fetch('https://cloud.higgsfield.ai/api/v1/generate', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + HIGGSFIELD_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'kling-avatar', inputs: { image_asset_id: imageAssetId, audio_asset_id: audioAssetId } })
  });
  const d = await r.json();
  if (!d.id) throw new Error('Generate failed: ' + JSON.stringify(d).slice(0,300));
  return d.id;
}

async function pollGeneration(genId) {
  const start = Date.now();
  while (Date.now() - start < 360000) {
    await new Promise(r => setTimeout(r, 6000));
    const r = await fetch('https://cloud.higgsfield.ai/api/v1/generate/' + genId, {
      headers: { 'Authorization': 'Bearer ' + HIGGSFIELD_KEY }
    });
    const d = await r.json();
    if (d.status === 'completed' && d.output_url) return d.output_url;
    if (d.status === 'failed') throw new Error('Generation failed: ' + (d.error || 'unknown'));
  }
  throw new Error('Timed out after 6 minutes');
}

app.post('/generate', upload.fields([{name:'photo',maxCount:1},{name:'bgPhoto',maxCount:1},{name:'voice',maxCount:1}]), async (req, res) => {
  const jobId = uuidv4();
  jobs[jobId] = { status:'processing', progress:10, message:'Starting...' };
  res.json({ jobId });
  let voiceId = null;
  const toClean = [];
  try {
    const photo = req.files['photo']?.[0];
    const voice = req.files['voice']?.[0];
    if (!photo || !voice) throw new Error('Missing photo or voice file');
    toClean.push(photo.path, voice.path);
    if (req.files['bgPhoto']?.[0]) toClean.push(req.files['bgPhoto'][0].path);
    const { script, agentName } = req.body;

    jobs[jobId] = { status:'processing', progress:20, message:'Cloning your voice...' };
    voiceId = await cloneVoice(voice.path, agentName);

    jobs[jobId] = { status:'processing', progress:35, message:'Generating speech...' };
    const audioPath = await textToSpeech(voiceId, script);
    toClean.push(audioPath);

    jobs[jobId] = { status:'processing', progress:50, message:'Uploading to Higgsfield...' };
    const [imageId, audioId] = await Promise.all([
      uploadToHiggsfield(photo.path, photo.mimetype),
      uploadToHiggsfield(audioPath, 'audio/mpeg')
    ]);

    jobs[jobId] = { status:'processing', progress:65, message:'Generating avatar video...' };
    const genId = await generateAvatar(imageId, audioId);

    jobs[jobId] = { status:'processing', progress:75, message:'Rendering — 2-4 minutes...' };
    const videoUrl = await pollGeneration(genId);

    jobs[jobId] = { status:'processing', progress:90, message:'Downloading video...' };
    const videoBuf = await fetch(videoUrl).then(r => r.buffer());
    const out = '/tmp/avatar-' + jobId + '.mp4';
    fs.writeFileSync(out, videoBuf);

    toClean.forEach(f => { try{fs.unlinkSync(f);}catch(e){} });
    if (voiceId) await deleteVoice(voiceId);
    jobs[jobId] = { status:'done', progress:100, message:'Avatar video ready!', outputPath:out };
  } catch(err) {
    console.error(err.message);
    jobs[jobId] = { status:'error', progress:0, error:err.message };
    toClean.forEach(f => { try{fs.unlinkSync(f);}catch(e){} });
    if (voiceId) await deleteVoice(voiceId);
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
  res.download(j.outputPath,'qcv-avatar-video.mp4');
});

app.listen(PORT, () => console.log('QCV Avatar running on port ' + PORT));
