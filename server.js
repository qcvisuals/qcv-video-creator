const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const fetch = (...args) => import('node-fetch').then(({default:f}) => f(...args));

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 50 * 1024 * 1024 } });
app.use(express.static(path.join(__dirname, 'public')));

const HEYGEN_KEY = 'sk_V2_hgu_kJjvg9V1Rto_jBsGXV0qejoFst2XD8L8cIJBQnf4yNGC';
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

async function heygenGet(endpoint) {
  const r = await fetch('https://api.heygen.com'+endpoint, {
    headers: {'X-Api-Key':HEYGEN_KEY,'Accept':'application/json'}
  });
  const t = await r.text();
  try{return JSON.parse(t);}catch(e){throw new Error('Parse: '+t.slice(0,200));}
}

async function heygenPost(endpoint, body) {
  const r = await fetch('https://api.heygen.com'+endpoint, {
    method:'POST',
    headers:{'X-Api-Key':HEYGEN_KEY,'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify(body)
  });
  const t = await r.text();
  try{return JSON.parse(t);}catch(e){throw new Error('Parse: '+t.slice(0,200));}
}

async function uploadAsset(filePath, mimeType) {
  const buf = fs.readFileSync(filePath);
  const r = await fetch('https://upload.heygen.com/v1/asset', {
    method:'POST',
    headers:{'X-Api-Key':HEYGEN_KEY,'Content-Type':mimeType,'Accept':'application/json'},
    body:buf
  });
  const t = await r.text();
  let d; try{d=JSON.parse(t);}catch(e){throw new Error('Upload parse: '+t.slice(0,300));}
  if(d.error) throw new Error('Upload: '+JSON.stringify(d.error).slice(0,200));
  const id = d.data?.id || d.data?.asset_id;
  if(!id) throw new Error('No asset ID: '+t.slice(0,300));
  return id;
}

async function createTalkingPhoto(imageAssetId) {
  const d = await heygenPost('/v2/photo_avatar/photo/generate', {
    image_asset_id: imageAssetId,
    attributes: { gender: 'neutral' }
  });
  if(d.error) throw new Error('Photo avatar create: '+JSON.stringify(d.error).slice(0,200));
  const talkingPhotoId = d.data?.talking_photo_id || d.data?.id;
  if(!talkingPhotoId) throw new Error('No talking_photo_id: '+JSON.stringify(d).slice(0,300));
  return talkingPhotoId;
}

async function generateVideo(talkingPhotoId, audioAssetId, aspectRatio) {
  const isShort = aspectRatio !== '4x5';
  const body = {
    video_inputs: [{
      character: {
        type: 'talking_photo',
        talking_photo_id: talkingPhotoId,
        scale: 1.0,
        talking_style: 'expressive'
      },
      voice: {
        type: 'audio',
        audio_asset_id: audioAssetId
      },
      background: { type: 'color', value: '#000000' }
    }],
    dimension: { width: 1080, height: isShort ? 1920 : 1350 },
    caption: false
  };
  const d = await heygenPost('/v2/video/generate', body);
  if(d.error) throw new Error('Generate error: '+JSON.stringify(d.error).slice(0,200));
  const videoId = d.data?.video_id;
  if(!videoId) throw new Error('No video_id: '+JSON.stringify(d).slice(0,300));
  return videoId;
}

async function pollVideo(videoId, jobId) {
  const start = Date.now();
  let attempt = 0;
  while(Date.now()-start < 360000) {
    await new Promise(r=>setTimeout(r,5000));
    attempt++;
    const d = await heygenGet('/v1/video_status.get?video_id='+videoId);
    const status = d.data?.status;
    jobs[jobId] = {status:'processing',progress:Math.min(72+attempt*3,93),message:'Rendering avatar... ('+Math.round((Date.now()-start)/1000)+'s)'};
    if(status==='completed'&&d.data?.video_url) return d.data.video_url;
    if(status==='failed') throw new Error('Render failed: '+(d.data?.error||JSON.stringify(d).slice(0,200)));
  }
  throw new Error('Timed out');
}

app.post('/generate', upload.fields([{name:'photo',maxCount:1},{name:'bgPhoto',maxCount:1},{name:'voice',maxCount:1}]), async(req,res)=>{
  const jobId = uuidv4();
  jobs[jobId] = {status:'processing',progress:8,message:'Starting...'};
  res.json({jobId});
  const toClean = [];
  try {
    const photo = req.files['photo']?.[0];
    const voice = req.files['voice']?.[0];
    if(!photo) throw new Error('No photo uploaded');
    if(!voice) throw new Error('No voice uploaded');
    toClean.push(photo.path, voice.path);
    if(req.files['bgPhoto']?.[0]) toClean.push(req.files['bgPhoto'][0].path);
    const {aspectRatio} = req.body;

    jobs[jobId] = {status:'processing',progress:18,message:'Converting audio...'};
    const mp3 = await convertToMp3(voice.path);
    toClean.push(mp3);

    jobs[jobId] = {status:'processing',progress:28,message:'Uploading your photo...'};
    const imageAssetId = await uploadAsset(photo.path, photo.mimetype||'image/jpeg');

    jobs[jobId] = {status:'processing',progress:40,message:'Creating your avatar...'};
    const talkingPhotoId = await createTalkingPhoto(imageAssetId);

    jobs[jobId] = {status:'processing',progress:52,message:'Uploading your voice...'};
    const audioAssetId = await uploadAsset(mp3, 'audio/mpeg');

    jobs[jobId] = {status:'processing',progress:64,message:'Generating talking avatar video...'};
    const videoId = await generateVideo(talkingPhotoId, audioAssetId, aspectRatio);

    jobs[jobId] = {status:'processing',progress:72,message:'Rendering — 1-3 minutes...'};
    const videoUrl = await pollVideo(videoId, jobId);

    jobs[jobId] = {status:'processing',progress:94,message:'Downloading...'};
    const buf = Buffer.from(await fetch(videoUrl).then(r=>r.arrayBuffer()));
    const out = '/tmp/avatar-'+jobId+'.mp4';
    fs.writeFileSync(out, buf);
    toClean.forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
    jobs[jobId] = {status:'done',progress:100,message:'Your avatar video is ready!',outputPath:out};

  } catch(err) {
    console.error('Error:',err.message);
    jobs[jobId] = {status:'error',progress:0,error:err.message};
    toClean.forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
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

app.listen(PORT,()=>console.log('QCV HeyGen Avatar running on port '+PORT));
