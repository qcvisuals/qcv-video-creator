const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 50*1024*1024 } });
app.use(express.static(path.join(__dirname, 'public')));

const ORDERS_FILE = '/tmp/qcv_orders.json';
function loadOrders(){try{return JSON.parse(fs.readFileSync(ORDERS_FILE,'utf8'));}catch(e){return {};}}
function saveOrder(id,data){const o=loadOrders();o[id]=data;try{fs.writeFileSync(ORDERS_FILE,JSON.stringify(o));}catch(e){}}
function getOrder(id){return loadOrders()[id];}

function ffmpeg(args){
  return new Promise((resolve,reject)=>{
    const p=spawn('ffmpeg',args,{stdio:['ignore','pipe','pipe']});
    let e='';p.stderr.on('data',d=>e+=d);
    p.on('close',c=>c===0?resolve():reject(new Error(e.slice(-200))));
  });
}

app.post('/submit', upload.fields([{name:'photo',maxCount:1},{name:'voice',maxCount:1}]), async(req,res)=>{
  const orderId = uuidv4().slice(0,8).toUpperCase();
  try {
    const photo = req.files['photo']?.[0];
    const voice = req.files['voice']?.[0];
    if(!photo) return res.json({error:'No photo uploaded'});
    if(!voice) return res.json({error:'No voice uploaded'});
    const b = req.body;

    // Convert voice to mp3 and photo to jpg for storage
    const mp3Path = '/tmp/order-'+orderId+'-voice.mp3';
    const jpgPath = '/tmp/order-'+orderId+'-photo.jpg';
    await ffmpeg(['-y','-i',voice.path,'-vn','-acodec','libmp3lame','-ar','44100','-ab','128k',mp3Path]);
    await ffmpeg(['-y','-i',photo.path,'-vframes','1','-f','image2','-vcodec','mjpeg',jpgPath]);

    // Clean up original uploads
    try{fs.unlinkSync(photo.path);}catch(e){}
    try{fs.unlinkSync(voice.path);}catch(e){}

    const order = {
      orderId,
      status: 'received',
      agentName: b.agentName||'',
      agentEmail: b.agentEmail||'',
      agentPhone: b.agentPhone||'',
      brokerage: b.brokerage||'',
      address: b.address||'',
      cityState: b.cityState||'',
      price: b.price||'',
      beds: b.beds||'',
      baths: b.baths||'',
      occasion: b.occasion||'Just Listed',
      script: b.script||'',
      frame: b.frame||'centered',
      bgColor: b.bgColor||'#1a1a2e',
      aspectRatio: b.aspectRatio||'9x16',
      photoPath: jpgPath,
      audioPath: mp3Path,
      submittedAt: new Date().toISOString()
    };

    saveOrder(orderId, order);
    res.json({ success: true, orderId });

  } catch(err) {
    console.error('Submit error:', err.message);
    res.json({ error: err.message });
  }
});

// Serve order files for Claude Cowork to download
app.get('/order/:id/photo', (req,res)=>{
  const o=getOrder(req.params.id);
  if(!o||!o.photoPath) return res.status(404).send('Not found');
  res.download(o.photoPath, 'photo-'+o.orderId+'.jpg');
});

app.get('/order/:id/audio', (req,res)=>{
  const o=getOrder(req.params.id);
  if(!o||!o.audioPath) return res.status(404).send('Not found');
  res.download(o.audioPath, 'voice-'+o.orderId+'.mp3');
});

app.get('/order/:id', (req,res)=>{
  const o=getOrder(req.params.id);
  if(!o) return res.status(404).json({error:'Order not found'});
  res.json(o);
});

app.get('/orders', (req,res)=>{
  const orders = loadOrders();
  const list = Object.values(orders).sort((a,b)=>new Date(b.submittedAt)-new Date(a.submittedAt));
  res.json(list);
});

app.post('/order/:id/complete', express.json(), (req,res)=>{
  const o=getOrder(req.params.id);
  if(!o) return res.status(404).json({error:'Not found'});
  saveOrder(req.params.id, {...o, status:'completed', completedAt: new Date().toISOString(), videoUrl: req.body.videoUrl||''});
  res.json({success:true});
});

app.listen(PORT, ()=>console.log('QCV Avatar Orders running on port '+PORT));
