const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const fetch = (...args) => import('node-fetch').then(({default:f}) => f(...args));
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.static(path.join(__dirname, 'public')));

const HEYGEN_KEY = 'sk_V2_hgu_kJjvg9V1Rto_jBsGXV0qejoFst2XD8L8cIJBQnf4yNGC';
const ELEVEN_KEY = 'sk_d09df28c46e9422b1fd3ad6729e3a3580a38f1b5ebc1bc3f';
const jobs = {};

function convertToMp3(inputPath) {
  return new Promise((resolve, reject) => {
    const out = inputPath + '.mp3';
    const p = spawn('ffmpeg', ['-y','-i',inputPath,'-vn','-acodec','libmp3lame','-ar','44100','-ab','128k',out]);
    let err = '';
    p.stderr.on('data', d => err += d.toString());
    p.on('close', c => c === 0 ? resolve(out) : reject(new Error('FFmpeg: '+err.slice(-200))));
  });
}

async function cloneVoice(mp3Path, name) {
  const fd = new FormData();
  fd.append('name', name || 'QCV Agent Voice');
  fd.append('files', fs.createReadStream(mp3Path), { filename: 'voice.mp3', contentType: 'audio/mpeg' });
  const r = await fetch('https://api.elevenlabs.io/v1/voices/add', {
    method: 'POST',
    headers: { 'xi-api-key': ELEVEN_KEY, ...fd.getHeaders() },
    body: fd
  });
  const t = await r.text();
  let d; try{d=JSON.parse(t);}catch(e){throw new Error('EL clone parse: '+t.slice(0,300));}
  if(!d.voice_id) throw new Error('Voice clone failed: '+JSON.stringify(d).slice(0,300));
  return d.voice_id;
}

async function textToSpeech(voiceId, script) {
  const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+voiceId, {
    method: 'POST',
    headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body: JSON.stringify({ text: script, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.8 } })
  });
  if(!r.ok) throw new Error('TTS failed: '+(await r.text()).slice(0,200));
  const buf = Buffer.from(await r.arrayBuffer());
  const out = '/tmp/tts-'+uuidv4()+'.mp3';
  fs.writeFileSync(out, buf);
  return out;
}

async function deleteVoice(voiceId) {
  try { await fetch('https://api.elevenlabs.io/v1/voices/'+voiceId,{method:'DELETE',headers:{'xi-api-key':ELEVEN_KEY}}); } catch(e){}
}

async function uploadToHeygen(filePath, mimeType) {
  const buf = fs.readFileSync(filePath);
  const r = await fetch('https://upload.heygen.com/v1/asset', {
    method: 'POST',
    headers: { 'X-Api-Key': HEYGEN_KEY, 'Content-Type': mimeType, 'Accept': 'application/json' },
    body: buf
  });
  const t = await r.text();
  let d; try{d=JSON.parse(t);}catch(e){throw new Error('HeyGen upload parse: '+t.slice(0,300));}
  if(d.error) throw new Error('HeyGen upload: '+JSON.stringify(d.error).slice(0,200));
  const id = d.data?.id || d.data?.asset_id;
  if(!id) throw new Error('No asset ID: '+t.slice(0,300));
  return id;
}

async function generateVideo(imageId, audioId, aspectRatio) {
  const height = aspectRatio === '4x5' ? 1350 : 1920;
  const body = {
    video_inputs: [{
      character: { type: 'talking_photo', talking_photo_id: imageId, scale: 1.0, talking_style: 'expressive' },
      voice: { type: 'audio', audio_asset_id: audioId },
      background: { type: 'color', value: '#000000' }
    }],
    dimension: { width: 1080, height },
    caption: false
  };
  const r = await fetch('https://api.heygen.com/v2/video/generate', {
    method: 'POST',
    headers: { 'X-Api-Key': HEYGEN_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  let d; try{d=JSON.parse(t);}catch(e){throw new Error('HeyGen gen parse: '+t.slice(0,300));}
  if(d.error) throw new Error('Generate: '+JSON.stringify(d.error).slice(0,300));
  const videoId = d.data?.video_id;
  if(!videoId) throw new Error('No video_id: '+JSON.stringify(d).slice(0,300));
  return videoId;
}

async function pollVideo(videoId, jobId) {
  const start = Date.now();
  let attempt = 0;
  while(Date.now()-start < 420000) {
    await new Promise(r=>setTimeout(r,6000));
    attempt++;
    const r = await fetch('https://api.heygen.com/v1/video_status.get?video_id='+videoId, {
      headers: { 'X-Api-Key': HEYGEN_KEY, 'Accept': 'application/json' }
    });
    const d = await r.json();
    const status = d.data?.status;
    jobs[jobId] = {status:'processing',progress:Math.min(72+attempt*2,93),message:'Rendering your avatar... ('+Math.round((Date.now()-start)/1000)+'s)'};
    if(status==='completed'&&d.data?.video_url) return d.data.video_url;
    if(status==='failed') throw new Error('Render failed: '+(d.data?.error||JSON.stringify(d).slice(0,200)));
  }
  throw new Error('Timed out after 7 minutes');
}

app.post('/generate', upload.fields([{name:'photo',maxCount:1},{name:'bgPhoto',maxCount:1},{name:'voice',maxCount:1}]), async(req,res)=>{
  const jobId = uuidv4();
  jobs[jobId] = {status:'processing',progress:5,message:'Starting...'};
  res.json({jobId});
  const toClean = [];
  let voiceId = null;
  try {
    const photo = req.files['photo']?.[0];
    const voice = req.files['voice']?.[0];
    if(!photo) throw new Error('No photo uploaded');
    if(!voice) throw new Error('No voice uploaded');
    toClean.push(photo.path, voice.path);
    if(req.files['bgPhoto']?.[0]) toClean.push(req.files['bgPhoto'][0].path);
    const { script, agentName, aspectRatio } = req.body;
    if(!script||script.trim().length<5) throw new Error('No script provided');

    jobs[jobId] = {status:'processing',progress:12,message:'Converting audio...'};
    const mp3 = await convertToMp3(voice.path);
    toClean.push(mp3);

    jobs[jobId] = {status:'processing',progress:22,message:'Cloning your voice...'};
    voiceId = await cloneVoice(mp3, agentName||'QCV Agent');

    jobs[jobId] = {status:'processing',progress:35,message:'Generating speech from your script...'};
    const ttsPath = await textToSpeech(voiceId, script);
    toClean.push(ttsPath);

    jobs[jobId] = {status:'processing',progress:48,message:'Uploading photo to HeyGen...'};
    const imageId = await uploadToHeygen(photo.path, photo.mimetype||'image/jpeg');

    jobs[jobId] = {status:'processing',progress:58,message:'Uploading cloned voice audio...'};
    const audioId = await uploadToHeygen(ttsPath, 'audio/mpeg');

    jobs[jobId] = {status:'processing',progress:68,message:'Generating talking avatar...'};
    const videoId = await generateVideo(imageId, audioId, aspectRatio);

    jobs[jobId] = {status:'processing',progress:72,message:'Rendering — 1-3 minutes...'};
    const videoUrl = await pollVideo(videoId, jobId);

    jobs[jobId] = {status:'processing',progress:95,message:'Downloading your video...'};
    const buf = Buffer.from(await fetch(videoUrl).then(r=>r.arrayBuffer()));
    const out = '/tmp/avatar-'+jobId+'.mp4';
    fs.writeFileSync(out, buf);
    toClean.forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
    if(voiceId) await deleteVoice(voiceId);
    jobs[jobId] = {status:'done',progress:100,message:'Your avatar video is ready!',outputPath:out};

  } catch(err) {
    console.error('Error:',err.message);
    jobs[jobId] = {status:'error',progress:0,error:err.message};
    toClean.forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
    if(voiceId) await deleteVoice(voiceId);
  }
});

app.get('/progress/:id',(req,res)=>{
  const j=jobs[req.params.id];
  if(!j) return res.status(404).json({error:'Not found'});
  res.json(j);
});

app.get('/download/:id',(req,res)=>{
  const j=jobs[req.params.id];
  if(!j||j.status!=='done') return res.status(404).json({error:'Not ready'});
  res.download(j.outputPath,'qcv-avatar-video.mp4');
});

app.listen(PORT,()=>console.log('QCV Avatar Creator running on port '+PORT));
