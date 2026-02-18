require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const nodemailer = require('nodemailer');
const fs = require('fs').promises;

const app = express();

// Datenbank (lokale JSON-Datei als persistenter Speicher)
const DB_PATH = process.env.DB_PATH || './data/jobs.json';

// Gmail OAuth2 für Email
const emailTransporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    type: 'OAuth2',
    user: process.env.GMAIL_FROM,
    clientId: process.env.GMAIL_CLIENT_ID,
    clientSecret: process.env.GMAIL_CLIENT_SECRET,
    refreshToken: process.env.GMAIL_REFRESH_TOKEN,
  },
});

// Admin Auth
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

function requireAdminAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (!ADMIN_API_KEY || apiKey !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
}));
app.use(compression());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests' }
});
app.use('/api/', limiter);

const jobLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Max 3 jobs per hour' }
});
app.use('/api/jobs', jobLimiter);

// ==================== JSON DATABASE ====================

let memoryJobs = new Map();

async function loadDatabase() {
  try {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    const data = await fs.readFile(DB_PATH, 'utf-8');
    const jobs = JSON.parse(data);
    memoryJobs = new Map(Object.entries(jobs));
    console.log(`[DB] Loaded ${memoryJobs.size} jobs`);
  } catch (err) {
    console.log('[DB] Starting fresh');
    memoryJobs = new Map();
  }
}

async function saveDatabase() {
  const data = Object.fromEntries(memoryJobs);
  await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2));
}

async function createJob(url, email) {
  const job = {
    id: uuidv4(),
    url,
    email,
    status: 'submitted',
    created_at: new Date().toISOString(),
    completed_at: null,
    lighthouse_before: null,
    lighthouse_after: null,
    netlify_url: null,
    notes: null,
  };
  
  memoryJobs.set(job.id, job);
  await saveDatabase();
  return job;
}

async function getPendingJobs() {
  return [...memoryJobs.values()].filter(j => j.status === 'submitted');
}

async function getAllJobs() {
  return [...memoryJobs.values()];
}

async function getJobById(id) {
  return memoryJobs.get(id) || null;
}

async function updateJobStatus(id, status) {
  const job = memoryJobs.get(id);
  if (job) {
    job.status = status;
    await saveDatabase();
  }
}

async function saveLighthouseBefore(id, scores) {
  const job = memoryJobs.get(id);
  if (job) {
    job.lighthouse_before = scores;
    await saveDatabase();
  }
}

async function saveLighthouseAfter(id, scores) {
  const job = memoryJobs.get(id);
  if (job) {
    job.lighthouse_after = scores;
    await saveDatabase();
  }
}

async function completeJob(id, netlifyUrl, notes) {
  const job = memoryJobs.get(id);
  if (job) {
    job.status = 'completed';
    job.completed_at = new Date().toISOString();
    job.netlify_url = netlifyUrl;
    job.notes = notes;
    await saveDatabase();
  }
}

// ==================== EMAIL SENDING ====================

async function sendCompletionEmail(job) {
  const before = job.lighthouse_before || {};
  const after = job.lighthouse_after || {};
  
  const improvement = after.performance && before.performance
    ? Math.round(after.performance - before.performance)
    : null;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
      <div style="background: linear-gradient(135deg, #667eea, #764ba2); padding: 30px; text-align: center; color: white;">
        <h1 style="margin: 0;">🚀 Deine Website-Optimierung ist fertig!</h1>
      </div>
      
      <div style="padding: 30px; background: #f9f9f9;">
        <p>Hallo,</p>
        <p>wir haben <strong>${job.url}</strong> analysiert und optimiert.</p>
        
        <h2 style="color: #667eea;">📊 Performance-Ergebnisse</h2>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <tr style="background: #e8f5e9;">
            <td style="padding: 12px; border: 1px solid #ddd;"><strong>Metrik</strong></td>
            <td style="padding: 12px; border: 1px solid #ddd;"><strong>Vorher</strong></td>
            <td style="padding: 12px; border: 1px solid #ddd;"><strong>Nachher</strong></td>
          </tr>
          <tr>
            <td style="padding: 12px; border: 1px solid #ddd;">Performance</td>
            <td style="padding: 12px; border: 1px solid #ddd;">${before.performance || 'N/A'}/100</td>
            <td style="padding: 12px; border: 1px solid #ddd; color: #2e7d32; font-weight: bold;">${after.performance || 'N/A'}/100</td>
          </tr>
          <tr>
            <td style="padding: 12px; border: 1px solid #ddd;">Accessibility</td>
            <td style="padding: 12px; border: 1px solid #ddd;">${before.accessibility || 'N/A'}/100</td>
            <td style="padding: 12px; border: 1px solid #ddd; color: #2e7d32; font-weight: bold;">${after.accessibility || 'N/A'}/100</td>
          </tr>
          <tr>
            <td style="padding: 12px; border: 1px solid #ddd;">Best Practices</td>
            <td style="padding: 12px; border: 1px solid #ddd;">${before.bestPractices || 'N/A'}/100</td>
            <td style="padding: 12px; border: 1px solid #ddd; color: #2e7d32; font-weight: bold;">${after.bestPractices || 'N/A'}/100</td>
          </tr>
          <tr>
            <td style="padding: 12px; border: 1px solid #ddd;">SEO</td>
            <td style="padding: 12px; border: 1px solid #ddd;">${before.seo || 'N/A'}/100</td>
            <td style="padding: 12px; border: 1px solid #ddd; color: #2e7d32; font-weight: bold;">${after.seo || 'N/A'}/100</td>
          </tr>
        </table>
        
        ${improvement !== null ? `
        <div style="background: #e8f5e9; padding: 15px; border-radius: 8px; margin: 20px 0; text-align: center;">
          <p style="margin: 0; font-size: 18px; color: #2e7d32;">
            🎉 <strong>+${improvement} Punkte</strong> Verbesserung!
          </p>
        </div>
        ` : ''}
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${job.netlify_url}" 
             style="display: inline-block; padding: 15px 30px; background: linear-gradient(135deg, #667eea, #764ba2); color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">
            ✨ Optimierte Website ansehen
          </a>
        </div>
        
        ${job.notes ? `
        <h3 style="color: #667eea;">📝 Optimierungs-Details</h3>
        <p>${job.notes}</p>
        ` : ''}
        
        <hr style="border: none; border-top: 2px solid #eee; margin: 30px 0;">
        
        <div style="background: linear-gradient(135deg, #fff8e1, #ffecb3); padding: 20px; border-radius: 8px; border: 2px solid #ffc107;">
          <h3 style="color: #f57c00; margin-top: 0;">🚀 Noch bessere Ergebnisse?</h3>
          <p style="margin-bottom: 15px;">
            <strong>In nur 7 Tagen können wir deine Website noch weiter optimieren:</strong>
          </p>
          <ul style="margin-bottom: 20px;">
            <li>✅ Noch schnellere Ladezeiten</li>
            <li>✅ Bessere Core Web Vitals</li>
            <li>✅ Optimierung für Mobile-First</li>
            <li>✅ Bild- und Video-Optimierung</li>
            <li>✅ CDN-Integration</li>
          </ul>
          <p style="margin: 0;">
            <strong>Interessiert?</strong> Antworte einfach auf diese E-Mail.
          </p>
        </div>
      </div>
      
      <div style="background: #333; color: #999; padding: 20px; text-align: center; font-size: 12px;">
        <p>Job ID: ${job.id}</p>
        <p>Optimiert von Ares (AI Assistant)</p>
      </div>
    </div>
  `;

  try {
    await emailTransporter.sendMail({
      from: `"Website Optimizer" <${process.env.GMAIL_FROM}>`,
      to: job.email,
      subject: `✅ Deine Website-Optimierung ist fertig - ${job.url}`,
      html,
    });
    console.log(`[EMAIL] Sent to ${job.email}`);
    return { success: true };
  } catch (err) {
    console.error(`[EMAIL ERROR] ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ==================== API ROUTES ====================

// Public: Submit Job
app.post('/api/jobs', async (req, res) => {
  try {
    const { url, email } = req.body;
    
    if (!url || !email) {
      return res.status(400).json({ error: 'URL and email required' });
    }

    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email' });
    }

    const job = await createJob(url, email);
    
    res.json({
      success: true,
      message: 'Job submitted! We will optimize your website and email you the results.',
      jobId: job.id
    });
  } catch (err) {
    console.error('[ERROR]', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Public: Check Job Status
app.get('/api/jobs/:id', async (req, res) => {
  try {
    const job = await getJobById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Get Pending Jobs
app.get('/api/jobs/pending', requireAdminAuth, async (req, res) => {
  try {
    const jobs = await getPendingJobs();
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Get All Jobs
app.get('/api/jobs/all', requireAdminAuth, async (req, res) => {
  try {
    const jobs = await getAllJobs();
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Save Lighthouse Before
app.post('/api/jobs/:id/lighthouse-before', requireAdminAuth, async (req, res) => {
  try {
    const { scores } = req.body;
    await updateJobStatus(req.params.id, 'processing');
    await saveLighthouseBefore(req.params.id, scores);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Save Lighthouse After
app.post('/api/jobs/:id/lighthouse-after', requireAdminAuth, async (req, res) => {
  try {
    const { scores } = req.body;
    await saveLighthouseAfter(req.params.id, scores);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Complete Job
app.post('/api/jobs/:id/complete', requireAdminAuth, async (req, res) => {
  try {
    const { netlifyUrl, notes } = req.body;
    if (!netlifyUrl) return res.status(400).json({ error: 'netlifyUrl required' });
    
    const job = await getJobById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    await completeJob(req.params.id, netlifyUrl, notes);
    const updatedJob = await getJobById(req.params.id);
    
    const emailResult = await sendCompletionEmail(updatedJob);
    
    res.json({
      success: true,
      emailSent: emailResult.success,
      job: updatedJob
    });
  } catch (err) {
    console.error('[COMPLETE ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start Server
const PORT = process.env.PORT || 3000;

loadDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`[SERVER] Website Optimizer PROD running on port ${PORT}`);
  });
});