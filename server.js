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

// Persist jobs to file so Railway restarts don't kill them
const JOBS_FILE = '/tmp/qcv_jobs.json';
function loadJobs() { try { return JSON.parse(fs.readFileSync(JOBS_FILE,'utf8')); } catch(e) { return {}; } }
function saveJob(id, data) { const j=loadJobs(); j[id]=data; try{fs.writeFileSync(JOBS_FILE,JSON.stringify(j));}catch(e){} }
function getJob(id) { return loadJobs()[id]; }

function ffmpeg(args) {
  return new Promise((resolve,reject)=>{
    const p=spawn('ffmpeg',args,{stdio:['ignore','pipe','pipe']});
    let e='';p.stderr.on('data',d=>e+=d);
    p.on('close',c=>c===0?resolve():reject(new Error(e.slice(-200))));
  });
}

async function heygenPost(endpoint, body) {
  const r=await fetch('https://api.heygen.com'+endpoint,{
    method:'POST',headers:{'X-Api-Key':HEYGEN_KEY,'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify(body)
  });
  const t=await r.text();try{return JSON.parse(t);}catch(e){throw new Error(t.slice(0,200));}
}

async function heygenGet(endpoint) {
  const r=await fetch('https://api.heygen.com'+endpoint,{headers:{'X-Api-Key':HEYGEN_KEY,'Accept':'application/json'}});
  const t=await r.text();try{return JSON.parse(t);}catch(e){throw new Error(t.slice(0,200));}
}

async function uploadAsset(filePath, mimeType) {
  const buf=fs.readFileSync(filePath);
  const r=await fetch('https://upload.heygen.com/v1/asset',{
    method:'POST',headers:{'X-Api-Key':HEYGEN_KEY,'Content-Type':mimeType,'Accept':'application/json'},body:buf
  });
  const t=await r.text();let d;try{d=JSON.parse(t);}catch(e){throw new Error('Upload:'+t.slice(0,200));}
  if(d.error) throw new Error('Upload:'+JSON.stringify(d.error).slice(0,200));
  console.log('Upload response:',JSON.stringify(d.data));
  const id=d.data?.id||d.data?.asset_id;
  const key=d.data?.image_key||d.data?.key||('image/'+id+'/original');
  if(!id) throw new Error('No asset ID:'+t.slice(0,200));
  return {id,key};
}

async function registerPhotoAvatar(imageId, imageKey) {
  const g=await heygenPost('/v2/photo_avatar/avatar_group/create',{name:'QCV-'+Date.now(),image_key:imageKey});
  console.log('Group create response:',JSON.stringify(g));
  if(g.error) throw new Error('Group:'+JSON.stringify(g.error).slice(0,200));
  const groupId=g.data?.id||g.data?.group_id;
  if(!groupId) throw new Error('No group_id:'+JSON.stringify(g).slice(0,200));
  // The group ID is also the talking_photo_id for this avatar
  return groupId;
}

async function cloneVoice(mp3Path, name) {
  const fd=new FormData();
  fd.append('name',name||'QCV');
  fd.append('files',fs.createReadStream(mp3Path),{filename:'voice.mp3',contentType:'audio/mpeg'});
  const r=await fetch('https://api.elevenlabs.io/v1/voices/add',{
    method:'POST',headers:{'xi-api-key':ELEVEN_KEY,...fd.getHeaders()},body:fd
  });
  const t=await r.text();let d;try{d=JSON.parse(t);}catch(e){throw new Error('EL:'+t.slice(0,200));}
  if(!d.voice_id) throw new Error('Clone:'+JSON.stringify(d).slice(0,200));
  return d.voice_id;
}

async function tts(voiceId, script) {
  const r=await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+voiceId,{
    method:'POST',
    headers:{'xi-api-key':ELEVEN_KEY,'Content-Type':'application/json','Accept':'audio/mpeg'},
    body:JSON.stringify({text:script,model_id:'eleven_multilingual_v2',voice_settings:{stability:0.5,similarity_boost:0.8}})
  });
  if(!r.ok) throw new Error('TTS:'+(await r.text()).slice(0,200));
  const buf=Buffer.from(await r.arrayBuffer());
  const out='/tmp/tts-'+uuidv4()+'.mp3';
  fs.writeFileSync(out,buf);return out;
}

async function deleteVoice(id){
  try{await fetch('https://api.elevenlabs.io/v1/voices/'+id,{method:'DELETE',headers:{'xi-api-key':ELEVEN_KEY}});}catch(e){}
}

async function generateVideo(talkingPhotoId, audioId, aspectRatio) {
  const height=aspectRatio==='4x5'?1350:1920;
  const d=await heygenPost('/v2/video/generate',{
    video_inputs:[{
      character:{type:'talking_photo',talking_photo_id:talkingPhotoId,scale:1.0,talking_style:'expressive'},
      voice:{type:'audio',audio_asset_id:audioId},
      background:{type:'color',value:'#000000'}
    }],
    dimension:{width:1080,height},caption:false
  });
  if(d.error) throw new Error('Generate:'+JSON.stringify(d.error).slice(0,300));
  const videoId=d.data?.video_id;
  if(!videoId) throw new Error('No video_id:'+JSON.stringify(d).slice(0,200));
  return videoId;
}

app.post('/generate', upload.fields([{name:'photo',maxCount:1},{name:'bgPhoto',maxCount:1},{name:'voice',maxCount:1}]), async(req,res)=>{
  const jobId=uuidv4();
  saveJob(jobId,{status:'processing',progress:5,message:'Starting...'});
  res.json({jobId});
  const toClean=[];let voiceId=null;
  try{
    const photo=req.files['photo']?.[0],voice=req.files['voice']?.[0];
    if(!photo) throw new Error('No photo');
    if(!voice) throw new Error('No voice');
    const{script,agentName,aspectRatio}=req.body;
    if(!script||script.trim().length<3) throw new Error('No script provided');
    toClean.push(photo.path,voice.path);
    if(req.files['bgPhoto']?.[0]) toClean.push(req.files['bgPhoto'][0].path);

    saveJob(jobId,{status:'processing',progress:12,message:'Converting audio...'});
    const mp3='/tmp/voice-'+jobId+'.mp3';
    await ffmpeg(['-y','-i',voice.path,'-vn','-acodec','libmp3lame','-ar','44100','-ab','128k',mp3]);
    toClean.push(mp3);

    saveJob(jobId,{status:'processing',progress:22,message:'Cloning your voice...'});
    voiceId=await cloneVoice(mp3,agentName||'QCV');

    saveJob(jobId,{status:'processing',progress:34,message:'Generating speech...'});
    const ttsPath=await tts(voiceId,script);
    toClean.push(ttsPath);

    saveJob(jobId,{status:'processing',progress:44,message:'Processing photo...'});
    // Use sharp to properly encode JPEG with dimensions
    const sharp = require('sharp');
    const jpegPath='/tmp/photo-'+jobId+'.jpg';
    await sharp(photo.path).jpeg({quality:90}).toFile(jpegPath);
    toClean.push(jpegPath);

    saveJob(jobId,{status:'processing',progress:52,message:'Creating avatar...'});
    const talkingPhotoId=await registerPhotoAvatar(imgAsset.id,imgAsset.key);

    saveJob(jobId,{status:'processing',progress:60,message:'Uploading voice audio...'});
    const audAsset=await uploadAsset(ttsPath,'audio/mpeg');

    saveJob(jobId,{status:'processing',progress:68,message:'Sending to HeyGen...'});
    const videoId=await generateVideo(talkingPhotoId,audAsset.id,aspectRatio);

    saveJob(jobId,{status:'processing',progress:72,message:'Rendering your avatar ÃÂ¢ÃÂÃÂ please wait...'});
    
    // Poll in background ÃÂ¢ÃÂÃÂ survives Railway restarts via file
    const start=Date.now();
    let attempt=0;
    const poll=async()=>{
      while(Date.now()-start<600000){
        await new Promise(r=>setTimeout(r,8000));
        attempt++;
        try{
          const d=await heygenGet('/v1/video_status.get?video_id='+videoId);
          const status=d.data?.status;
          console.log('Poll status:',status,'attempt:',attempt);
          saveJob(jobId,{status:'processing',progress:Math.min(74+attempt*2,94),message:'Rendering... ('+Math.round((Date.now()-start)/1000)+'s) ÃÂ¢ÃÂÃÂ HeyGen is processing your avatar'});
          if(status==='completed'&&d.data?.video_url){
            const buf=Buffer.from(await fetch(d.data.video_url).then(r=>r.arrayBuffer()));
            const out='/tmp/avatar-'+jobId+'.mp4';
            fs.writeFileSync(out,buf);
            toClean.forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
            if(voiceId) await deleteVoice(voiceId);
            saveJob(jobId,{status:'done',progress:100,message:'Your avatar video is ready!',outputPath:out});
            return;
          }
          if(status==='failed') throw new Error('HeyGen render failed: '+(d.data?.error||'unknown'));
        }catch(e){
          if(e.message.includes('render failed')) throw e;
          console.error('Poll error:',e.message);
        }
      }
      throw new Error('Timed out after 10 minutes');
    };
    poll().catch(err=>{
      console.error('Poll failed:',err.message);
      saveJob(jobId,{status:'error',progress:0,error:err.message});
      toClean.forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
      if(voiceId) deleteVoice(voiceId);
    });

  }catch(err){
    console.error('Error:',err.message);
    saveJob(jobId,{status:'error',progress:0,error:err.message});
    toClean.forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
    if(voiceId) deleteVoice(voiceId);
  }
});

app.get('/progress/:id',(req,res)=>{
  const j=getJob(req.params.id);
  if(!j) return res.status(404).json({error:'Not found'});
  res.json(j);
});

app.get('/download/:id',(req,res)=>{
  const j=getJob(req.params.id);
  if(!j||j.status!=='done') return res.status(404).json({error:'Not ready'});
  res.download(j.outputPath,'qcv-avatar-video.mp4');
});

app.listen(PORT,()=>console.log('QCV Avatar running on port '+PORT));
