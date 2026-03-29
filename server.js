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
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 50*1024*1024 } });
app.use(express.static(path.join(__dirname, 'public')));

const HEYGEN_KEY = 'sk_V2_hgu_kJjvg9V1Rto_jBsGXV0qejoFst2XD8L8cIJBQnf4yNGC';
const ELEVEN_KEY = 'sk_3604d78d3395fa66ff1fae915602dc529e079653a1909298';
const jobs = {};

function ffmpeg(args) {
  return new Promise((resolve,reject)=>{
    const p=spawn('ffmpeg',args,{stdio:['ignore','pipe','pipe']});
    let e='';p.stderr.on('data',d=>e+=d);
    p.on('close',c=>c===0?resolve():reject(new Error(e.slice(-200))));
  });
}

async function heygenPost(endpoint, body) {
  const r = await fetch('https://api.heygen.com'+endpoint, {
    method:'POST', headers:{'X-Api-Key':HEYGEN_KEY,'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify(body)
  });
  const t=await r.text(); try{return JSON.parse(t);}catch(e){throw new Error(t.slice(0,200));}
}

async function heygenGet(endpoint) {
  const r = await fetch('https://api.heygen.com'+endpoint, {headers:{'X-Api-Key':HEYGEN_KEY,'Accept':'application/json'}});
  const t=await r.text(); try{return JSON.parse(t);}catch(e){throw new Error(t.slice(0,200));}
}

async function uploadAsset(filePath, mimeType) {
  const buf=fs.readFileSync(filePath);
  const r=await fetch('https://upload.heygen.com/v1/asset',{
    method:'POST', headers:{'X-Api-Key':HEYGEN_KEY,'Content-Type':mimeType,'Accept':'application/json'}, body:buf
  });
  const t=await r.text(); let d; try{d=JSON.parse(t);}catch(e){throw new Error('Upload: '+t.slice(0,200));}
  if(d.error) throw new Error('Upload: '+JSON.stringify(d.error).slice(0,200));
  console.log('Upload response:', JSON.stringify(d.data));
  const id=d.data?.id||d.data?.asset_id||d.data?.image_asset_id;
  const key=d.data?.image_key||d.data?.key||('image/'+id+'/original');
  if(!id) throw new Error('No asset ID: '+t.slice(0,200));
  return {id, key};
}

async function registerPhotoAvatar(imageAssetId, imageKey) {
  // Step 1: Create avatar group
  const g = await heygenPost('/v2/photo_avatar/avatar_group/create', { name: 'QCV-'+Date.now(), image_key: imageKey });
  if(g.error) throw new Error('Group create: '+JSON.stringify(g.error).slice(0,200));
  const groupId = g.data?.group_id||g.data?.id;
  if(!groupId) throw new Error('No group_id: '+JSON.stringify(g).slice(0,200));

  // Step 2: Add photo to group
  const a = await heygenPost('/v2/photo_avatar/avatar_group/'+groupId+'/add', { image_key: imageKey||imageAssetId, image_asset_id: imageAssetId });
  if(a.error) throw new Error('Add photo: '+JSON.stringify(a.error).slice(0,200));
  const lookId = a.data?.look_id||a.data?.talking_photo_id||a.data?.id;
  if(!lookId) throw new Error('No look_id: '+JSON.stringify(a).slice(0,200));

  return lookId;
}

async function cloneVoice(mp3Path, name) {
  const fd=new FormData();
  fd.append('name',name||'QCV Agent');
  fd.append('files',fs.createReadStream(mp3Path),{filename:'voice.mp3',contentType:'audio/mpeg'});
  const r=await fetch('https://api.elevenlabs.io/v1/voices/add',{
    method:'POST', headers:{'xi-api-key':ELEVEN_KEY,...fd.getHeaders()}, body:fd
  });
  const t=await r.text(); let d; try{d=JSON.parse(t);}catch(e){throw new Error('EL: '+t.slice(0,200));}
  if(!d.voice_id) throw new Error('Clone failed: '+JSON.stringify(d).slice(0,200));
  return d.voice_id;
}

async function tts(voiceId, script) {
  const r=await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+voiceId,{
    method:'POST',
    headers:{'xi-api-key':ELEVEN_KEY,'Content-Type':'application/json','Accept':'audio/mpeg'},
    body:JSON.stringify({text:script,model_id:'eleven_multilingual_v2',voice_settings:{stability:0.5,similarity_boost:0.8}})
  });
  if(!r.ok) throw new Error('TTS: '+(await r.text()).slice(0,200));
  const buf=Buffer.from(await r.arrayBuffer());
  const out='/tmp/tts-'+uuidv4()+'.mp3';
  fs.writeFileSync(out,buf); return out;
}

async function deleteVoice(id) {
  try{await fetch('https://api.elevenlabs.io/v1/voices/'+id,{method:'DELETE',headers:{'xi-api-key':ELEVEN_KEY}});}catch(e){}
}

async function generateVideo(lookId, audioId, aspectRatio) {
  const height=aspectRatio==='4x5'?1350:1920;
  const d=await heygenPost('/v2/video/generate',{
    video_inputs:[{
      character:{type:'talking_photo',talking_photo_id:lookId,scale:1.0,talking_style:'expressive'},
      voice:{type:'audio',audio_asset_id:audioId},
      background:{type:'color',value:'#000000'}
    }],
    dimension:{width:1080,height}, caption:false
  });
  if(d.error) throw new Error('Generate: '+JSON.stringify(d.error).slice(0,300));
  const videoId=d.data?.video_id; if(!videoId) throw new Error('No video_id: '+JSON.stringify(d).slice(0,200));
  return videoId;
}

async function pollVideo(videoId, jobId) {
  const start=Date.now(); let attempt=0;
  while(Date.now()-start<420000){
    await new Promise(r=>setTimeout(r,6000)); attempt++;
    const d=await heygenGet('/v1/video_status.get?video_id='+videoId);
    const status=d.data?.status;
    jobs[jobId]={status:'processing',progress:Math.min(75+attempt*2,93),message:'Rendering your avatar... ('+Math.round((Date.now()-start)/1000)+'s)'};
    if(status==='completed'&&d.data?.video_url) return d.data.video_url;
    if(status==='failed') throw new Error('Render failed: '+(d.data?.error||JSON.stringify(d).slice(0,200)));
  }
  throw new Error('Timed out');
}

app.post('/generate', upload.fields([{name:'photo',maxCount:1},{name:'bgPhoto',maxCount:1},{name:'voice',maxCount:1}]), async(req,res)=>{
  const jobId=uuidv4();
  jobs[jobId]={status:'processing',progress:5,message:'Starting...'};
  res.json({jobId});
  const toClean=[]; let voiceId=null;
  try{
    const photo=req.files['photo']?.[0], voice=req.files['voice']?.[0];
    if(!photo) throw new Error('No photo');
    if(!voice) throw new Error('No voice');
    const {script,agentName,aspectRatio}=req.body;
    if(!script||script.trim().length<5) throw new Error('No script provided');
    toClean.push(photo.path,voice.path);
    if(req.files['bgPhoto']?.[0]) toClean.push(req.files['bgPhoto'][0].path);

    jobs[jobId]={status:'processing',progress:12,message:'Converting audio...'};
    const mp3='/tmp/voice-'+jobId+'.mp3';
    await ffmpeg(['-y','-i',voice.path,'-vn','-acodec','libmp3lame','-ar','44100','-ab','128k',mp3]);
    toClean.push(mp3);

    jobs[jobId]={status:'processing',progress:22,message:'Cloning your voice...'};
    voiceId=await cloneVoice(mp3,agentName||'QCV Agent');

    jobs[jobId]={status:'processing',progress:34,message:'Generating speech from your script...'};
    const ttsPath=await tts(voiceId,script);
    toClean.push(ttsPath);

    jobs[jobId]={status:'processing',progress:44,message:'Uploading photo...'};
    const imageAsset=await uploadAsset(photo.path,photo.mimetype||'image/jpeg');
    const imageId=imageAsset.id||imageAsset; const imageKey=imageAsset.key||imageAsset;

    jobs[jobId]={status:'processing',progress:52,message:'Registering your avatar...'};
    const lookId=await registerPhotoAvatar(imageId, imageKey);

    jobs[jobId]={status:'processing',progress:60,message:'Uploading cloned voice audio...'};
    const audioAsset=await uploadAsset(ttsPath,'audio/mpeg');
    const audioId=audioAsset.id||audioAsset;

    jobs[jobId]={status:'processing',progress:68,message:'Generating talking avatar video...'};
    const videoId=await generateVideo(lookId,audioId,aspectRatio);

    jobs[jobId]={status:'processing',progress:75,message:'Rendering ÃÂ¢ÃÂÃÂ 1-3 minutes...'};
    const videoUrl=await pollVideo(videoId,jobId);

    jobs[jobId]={status:'processing',progress:94,message:'Downloading your video...'};
    const buf=Buffer.from(await fetch(videoUrl).then(r=>r.arrayBuffer()));
    const out='/tmp/avatar-'+jobId+'.mp4';
    fs.writeFileSync(out,buf);
    toClean.forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
    if(voiceId) await deleteVoice(voiceId);
    jobs[jobId]={status:'done',progress:100,message:'Your avatar video is ready!',outputPath:out};

  }catch(err){
    console.error('Error:',err.message);
    jobs[jobId]={status:'error',progress:0,error:err.message};
    toClean.forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
    if(voiceId) await deleteVoice(voiceId);
  }
});

app.get('/progress/:id',(req,res)=>{const j=jobs[req.params.id];if(!j)return res.status(404).json({error:'Not found'});res.json(j);});
app.get('/download/:id',(req,res)=>{const j=jobs[req.params.id];if(!j||j.status!=='done')return res.status(404).json({error:'Not ready'});res.download(j.outputPath,'qcv-avatar-video.mp4');});
app.listen(PORT,()=>console.log('QCV Avatar running on port '+PORT));
