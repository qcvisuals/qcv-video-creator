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

const JOBS_FILE = '/tmp/qcv_jobs.json';
function loadJobs(){try{return JSON.parse(fs.readFileSync(JOBS_FILE,'utf8'));}catch(e){return {};}}
function saveJob(id,data){const j=loadJobs();j[id]=data;try{fs.writeFileSync(JOBS_FILE,JSON.stringify(j));}catch(e){}}
function getJob(id){return loadJobs()[id];}

function ffmpeg(args){
  return new Promise((resolve,reject)=>{
    const p=spawn('ffmpeg',args,{stdio:['ignore','pipe','pipe']});
    let e='';p.stderr.on('data',d=>e+=d);
    p.on('close',c=>c===0?resolve():reject(new Error(e.slice(-300))));
  });
}

async function heygenPost(endpoint,body){
  const r=await fetch('https://api.heygen.com'+endpoint,{
    method:'POST',headers:{'X-Api-Key':HEYGEN_KEY,'Content-Type':'application/json','Accept':'application/json'},
    body:JSON.stringify(body)
  });
  const t=await r.text();try{return JSON.parse(t);}catch(e){throw new Error(t.slice(0,200));}
}

async function heygenGet(endpoint){
  const r=await fetch('https://api.heygen.com'+endpoint,{headers:{'X-Api-Key':HEYGEN_KEY,'Accept':'application/json'}});
  const t=await r.text();try{return JSON.parse(t);}catch(e){throw new Error(t.slice(0,200));}
}

// Upload image using multipart form — required for HeyGen to detect dimensions
async function uploadImage(filePath){
  const fd = new FormData();
  fd.append('file', fs.createReadStream(filePath), {filename:'photo.jpg', contentType:'image/jpeg'});
  const r=await fetch('https://upload.heygen.com/v1/asset',{
    method:'POST',
    headers:{'X-Api-Key':HEYGEN_KEY,...fd.getHeaders(),'Accept':'application/json'},
    body:fd
  });
  const t=await r.text();let d;try{d=JSON.parse(t);}catch(e){throw new Error('ImgUpload:'+t.slice(0,300));}
  if(d.error)throw new Error('ImgUpload:'+JSON.stringify(d.error).slice(0,200));
  console.log('Image upload result:',JSON.stringify(d.data));
  const id=d.data?.id||d.data?.asset_id;
  if(!id)throw new Error('No image asset ID:'+t.slice(0,200));
  return id;
}

// Upload audio as raw binary — works fine for audio
async function uploadAudio(filePath){
  const buf=fs.readFileSync(filePath);
  const r=await fetch('https://upload.heygen.com/v1/asset',{
    method:'POST',headers:{'X-Api-Key':HEYGEN_KEY,'Content-Type':'audio/mpeg','Accept':'application/json'},body:buf
  });
  const t=await r.text();let d;try{d=JSON.parse(t);}catch(e){throw new Error('AudUpload:'+t.slice(0,300));}
  if(d.error)throw new Error('AudUpload:'+JSON.stringify(d.error).slice(0,200));
  console.log('Audio upload result:',JSON.stringify(d.data));
  const id=d.data?.id||d.data?.asset_id;
  if(!id)throw new Error('No audio asset ID:'+t.slice(0,200));
  return id;
}

async function registerAvatar(imageId){
  const imageKey='image/'+imageId+'/original';
  const g=await heygenPost('/v2/photo_avatar/avatar_group/create',{name:'QCV-'+Date.now(),image_key:imageKey});
  console.log('Avatar group result:',JSON.stringify(g));
  if(g.error)throw new Error('Avatar:'+JSON.stringify(g.error).slice(0,200));
  const groupId=g.data?.id||g.data?.group_id;
  if(!groupId)throw new Error('No group_id:'+JSON.stringify(g).slice(0,200));
  return groupId;
}

async function cloneVoice(mp3Path,name){
  const fd=new FormData();
  fd.append('name',name||'QCV');
  fd.append('files',fs.createReadStream(mp3Path),{filename:'voice.mp3',contentType:'audio/mpeg'});
  const r=await fetch('https://api.elevenlabs.io/v1/voices/add',{
    method:'POST',headers:{'xi-api-key':ELEVEN_KEY,...fd.getHeaders()},body:fd
  });
  const t=await r.text();let d;try{d=JSON.parse(t);}catch(e){throw new Error('EL:'+t.slice(0,200));}
  if(!d.voice_id)throw new Error('Clone:'+JSON.stringify(d).slice(0,200));
  return d.voice_id;
}

async function tts(voiceId,script){
  const r=await fetch('https://api.elevenlabs.io/v1/text-to-speech/'+voiceId,{
    method:'POST',
    headers:{'xi-api-key':ELEVEN_KEY,'Content-Type':'application/json','Accept':'audio/mpeg'},
    body:JSON.stringify({text:script,model_id:'eleven_multilingual_v2',voice_settings:{stability:0.5,similarity_boost:0.8}})
  });
  if(!r.ok)throw new Error('TTS:'+(await r.text()).slice(0,200));
  const buf=Buffer.from(await r.arrayBuffer());
  const out='/tmp/tts-'+uuidv4()+'.mp3';
  fs.writeFileSync(out,buf);return out;
}

async function deleteVoice(id){
  try{await fetch('https://api.elevenlabs.io/v1/voices/'+id,{method:'DELETE',headers:{'xi-api-key':ELEVEN_KEY}});}catch(e){}
}

async function generateVideo(talkingPhotoId,audioId,aspectRatio){
  const height=aspectRatio==='4x5'?1350:1920;
  const d=await heygenPost('/v2/video/generate',{
    video_inputs:[{
      character:{type:'talking_photo',talking_photo_id:talkingPhotoId,scale:1.0,talking_style:'expressive'},
      voice:{type:'audio',audio_asset_id:audioId},
      background:{type:'color',value:'#000000'}
    }],
    dimension:{width:1080,height},caption:false
  });
  if(d.error)throw new Error('Generate:'+JSON.stringify(d.error).slice(0,300));
  const videoId=d.data?.video_id;
  if(!videoId)throw new Error('No video_id:'+JSON.stringify(d).slice(0,200));
  return videoId;
}

app.post('/generate',upload.fields([{name:'photo',maxCount:1},{name:'bgPhoto',maxCount:1},{name:'voice',maxCount:1}]),async(req,res)=>{
  const jobId=uuidv4();
  saveJob(jobId,{status:'processing',progress:5,message:'Starting...'});
  res.json({jobId});
  const toClean=[];let voiceId=null;
  try{
    const photo=req.files['photo']?.[0];
    const voice=req.files['voice']?.[0];
    if(!photo)throw new Error('No photo');
    if(!voice)throw new Error('No voice');
    const{script,agentName,aspectRatio}=req.body;
    if(!script||script.trim().length<3)throw new Error('No script provided');
    toClean.push(photo.path,voice.path);
    if(req.files['bgPhoto']?.[0])toClean.push(req.files['bgPhoto'][0].path);

    saveJob(jobId,{status:'processing',progress:10,message:'Converting audio...'});
    const mp3='/tmp/voice-'+jobId+'.mp3';
    await ffmpeg(['-y','-i',voice.path,'-vn','-acodec','libmp3lame','-ar','44100','-ab','128k',mp3]);
    toClean.push(mp3);

    saveJob(jobId,{status:'processing',progress:18,message:'Converting photo to JPEG...'});
    const jpegPath='/tmp/photo-'+jobId+'.jpg';
    await ffmpeg(['-y','-i',photo.path,'-vframes','1','-f','image2','-vcodec','mjpeg',jpegPath]);
    toClean.push(jpegPath);

    saveJob(jobId,{status:'processing',progress:26,message:'Cloning your voice...'});
    voiceId=await cloneVoice(mp3,agentName||'QCV');

    saveJob(jobId,{status:'processing',progress:36,message:'Generating speech from script...'});
    const ttsPath=await tts(voiceId,script);
    toClean.push(ttsPath);

    saveJob(jobId,{status:'processing',progress:44,message:'Uploading photo...'});
    const imageId=await uploadImage(jpegPath);

    saveJob(jobId,{status:'processing',progress:52,message:'Creating your avatar...'});
    const talkingPhotoId=await registerAvatar(imageId);

    saveJob(jobId,{status:'processing',progress:60,message:'Uploading voice audio...'});
    const audioId=await uploadAudio(ttsPath);

    saveJob(jobId,{status:'processing',progress:68,message:'Generating talking avatar video...'});
    const videoId=await generateVideo(talkingPhotoId,audioId,aspectRatio);

    saveJob(jobId,{status:'processing',progress:72,message:'Rendering your avatar — please wait...'});

    const start=Date.now();let attempt=0;
    const poll=async()=>{
      while(Date.now()-start<600000){
        await new Promise(r=>setTimeout(r,8000));
        attempt++;
        try{
          const d=await heygenGet('/v1/video_status.get?video_id='+videoId);
          const status=d.data?.status;
          console.log('Poll status:',status,'attempt:',attempt);
          saveJob(jobId,{status:'processing',progress:Math.min(74+attempt*2,94),message:'Rendering... ('+Math.round((Date.now()-start)/1000)+'s) — HeyGen is processing your avatar'});
          if(status==='completed'&&d.data?.video_url){
            const buf=Buffer.from(await fetch(d.data.video_url).then(r=>r.arrayBuffer()));
            const out='/tmp/avatar-'+jobId+'.mp4';
            fs.writeFileSync(out,buf);
            toClean.forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
            if(voiceId)await deleteVoice(voiceId);
            saveJob(jobId,{status:'done',progress:100,message:'Your avatar video is ready!',outputPath:out});
            return;
          }
          if(status==='failed')throw new Error('HeyGen render failed:'+(d.data?.error||'unknown'));
        }catch(e){
          if(e.message.includes('render failed'))throw e;
          console.error('Poll error:',e.message);
        }
      }
      throw new Error('Timed out after 10 minutes');
    };
    poll().catch(err=>{
      console.error('Poll failed:',err.message);
      saveJob(jobId,{status:'error',progress:0,error:err.message});
      toClean.forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
      if(voiceId)deleteVoice(voiceId);
    });

  }catch(err){
    console.error('Error:',err.message);
    saveJob(jobId,{status:'error',progress:0,error:err.message});
    toClean.forEach(f=>{try{fs.unlinkSync(f);}catch(e){}});
    if(voiceId)deleteVoice(voiceId);
  }
});

app.get('/progress/:id',(req,res)=>{const j=getJob(req.params.id);if(!j)return res.status(404).json({error:'Not found'});res.json(j);});
app.get('/download/:id',(req,res)=>{const j=getJob(req.params.id);if(!j||j.status!=='done')return res.status(404).json({error:'Not ready'});res.download(j.outputPath,'qcv-avatar-video.mp4');});
app.listen(PORT,()=>console.log('QCV Avatar running on port '+PORT));
