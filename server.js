const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 50*1024*1024 } });
app.use(express.static(path.join(__dirname, 'public')));

const ORDERS_FILE = '/tmp/qcv_orders.json';
function loadOrders(){try{return JSON.parse(fs.readFileSync(ORDERS_FILE,'utf8'));}catch(e){return {};}}
function saveOrder(id,data){const o=loadOrders();o[id]=data;try{fs.writeFileSync(ORDERS_FILE,JSON.stringify(o));}catch(e){}}
function getOrder(id){return loadOrders()[id];}

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: 'qualitycapturevisuals@gmail.com', pass: process.env.GMAIL_APP_PASSWORD }
});

app.post('/submit', upload.fields([{name:'photo',maxCount:1},{name:'voice',maxCount:1}]), async(req,res)=>{
  const orderId = uuidv4().slice(0,8).toUpperCase();
  try {
    const photo = req.files['photo']?.[0];
    const voice = req.files['voice']?.[0];
    if(!photo) return res.json({error:'No photo uploaded'});
    if(!voice) return res.json({error:'No voice uploaded'});

    const b = req.body;
    const agentName = b.agentName||'Agent';
    const script = b.script||'';
    const occasion = b.occasion||'Just Listed';
    const price = b.price||'';
    const address = b.address||'';
    const cityState = b.cityState||'';
    const beds = b.beds||'';
    const baths = b.baths||'';
    const agentPhone = b.agentPhone||'';
    const brokerage = b.brokerage||'';
    const frameStyle = b.frame||'centered';
    const bgColor = b.bgColor||'#1a1a2e';
    const aspectRatio = b.aspectRatio||'9x16';

    saveOrder(orderId, {
      status: 'received',
      agentName, agentPhone, brokerage,
      address, cityState, price, beds, baths,
      occasion, script, frameStyle, bgColor, aspectRatio,
      submittedAt: new Date().toISOString()
    });

    const mailOptions = {
      from: 'qualitycapturevisuals@gmail.com',
      to: 'qualitycapturevisuals@gmail.com',
      subject: 'QCV Avatar Request #'+orderId+' — '+agentName,
      html: `
        <h2>New Avatar Video Request</h2>
        <p><strong>Order ID:</strong> ${orderId}</p>
        <p><strong>Agent:</strong> ${agentName}</p>
        <p><strong>Phone:</strong> ${agentPhone}</p>
        <p><strong>Brokerage:</strong> ${brokerage}</p>
        <hr>
        <p><strong>Property:</strong> ${address}, ${cityState}</p>
        <p><strong>Price:</strong> ${price}</p>
        <p><strong>Beds/Baths:</strong> ${beds} bd / ${baths} ba</p>
        <p><strong>Occasion:</strong> ${occasion}</p>
        <hr>
        <p><strong>Script:</strong></p>
        <blockquote>${script}</blockquote>
        <hr>
        <p><strong>Frame:</strong> ${frameStyle} | <strong>Color:</strong> ${bgColor} | <strong>Ratio:</strong> ${aspectRatio}</p>
      `,
      attachments: [
        { filename: 'headshot-'+agentName.replace(/\s/g,'-')+'.jpg', path: photo.path },
        { filename: 'voice-'+agentName.replace(/\s/g,'-')+'.webm', path: voice.path }
      ]
    };

    await transporter.sendMail(mailOptions);

    // Send confirmation to agent if email provided
    if(b.agentEmail) {
      await transporter.sendMail({
        from: 'qualitycapturevisuals@gmail.com',
        to: b.agentEmail,
        subject: 'QCV Avatar Video — Order Received #'+orderId,
        html: `<p>Hi ${agentName},</p><p>We received your avatar video request (Order #${orderId}). Your video will be ready within 24 hours.</p><p>— Quality Capture Visuals</p>`
      });
    }

    res.json({ success: true, orderId });
  } catch(err) {
    console.error('Submit error:', err.message);
    res.json({ error: err.message });
  }
});

app.get('/order/:id', (req,res)=>{
  const o = getOrder(req.params.id);
  if(!o) return res.status(404).json({error:'Order not found'});
  res.json(o);
});

app.listen(PORT, ()=>console.log('QCV Avatar Submit running on port '+PORT));
