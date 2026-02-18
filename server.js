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
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();

// Google Sheets als Datenbank
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_ACCESS_TOKEN = process.env.GOOGLE_ACCESS_TOKEN;

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

// ==================== GOOGLE SHEETS FUNCTIONS ====================

async function sheetsRequest(range, method = 'GET', body = null) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${GOOGLE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);
  
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Sheets API error: ${error}`);
  }
  return response.json();
}

async function initSheet() {
  if (!SHEET_ID) {
    console.log('[DB] No SHEET_ID set - using in-memory storage');
    return;
  }
  
  try {
    // Check if sheet has headers, if not create them
    const result = await sheetsRequest('Jobs!A1:J1');
    if (!result.values || result.values.length === 0) {
      // Create headers
      await sheetsRequest('Jobs!A1:J1', 'PUT', {
        values: [['id', 'url', 'email', 'status', 'created_at', 'completed_at', 'lighthouse_before', 'lighthouse_after', 'netlify_url', 'notes']]
      });
      console.log('[DB] Sheet initialized with headers');
    } else {
      console.log('[DB] Sheet ready');
    }
  } catch (err) {
    console.error('[DB ERROR]', err.message);
  }
}

// In-memory fallback
const memoryJobs = new Map();

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
  
  if (SHEET_ID && GOOGLE_ACCESS_TOKEN) {
    try {
      await sheetsRequest('Jobs!A:J', 'POST', {
        values: [[job.id, job.url, job.email, job.status, job.created_at, job.completed_at, job.lighthouse_before, job.lighthouse_after, job.netlify_url, job.notes]]
      });
    } catch (err) {
      console.error('[DB ERROR]', err);
      memoryJobs.set(job.id, job);
    }
  } else {
    memoryJobs.set(job.id, job);
  }
  
  return job;
}

async function getPendingJobs() {
  if (SHEET_ID && GOOGLE_ACCESS_TOKEN) {
    try {
      const result = await sheetsRequest('Jobs!A2:J');
      if (!result.values) return [];
      
      return result.values
        .filter(row => row[3] === 'submitted')
        .map(row => ({
          id: row[0],
          url: row[1],
          email: row[2],
          status: row[3],
          created_at: row[4],
          completed_at: row[5] || null,
          lighthouse_before: row[6] ? JSON.parse(row[6]) : null,
          lighthouse_after: row[7] ? JSON.parse(row[7]) : null,
          netlify_url: row[8] || null,
          notes: row[9] || null,
        }));
    } catch (err) {
      console.error('[DB ERROR]', err);
    }
  }
  
  // Fallback to memory
  return [...memoryJobs.values()].filter(j => j.status === 'submitted');
}

async function getAllJobs() {
  if (SHEET_ID && GOOGLE_ACCESS_TOKEN) {
    try {
      const result = await sheetsRequest('Jobs!A2:J');
      if (!result.values) return [];
      
      return result.values.map(row => ({
        id: row[0],
        url: row[1],
        email: row[2],
        status: row[3],
        created_at: row[4],
        completed_at: row[5] || null,
        lighthouse_before: row[6] ? JSON.parse(row[6]) : null,
        lighthouse_after: row[7] ? JSON.parse(row[7]) : null,
        netlify_url: row[8] || null,
        notes: row[9] || null,
      }));
    } catch (err) {
      console.error('[DB ERROR]', err);
    }
  }
  
  return [...memoryJobs.values()];
}

async function getJobById(id) {
  if (SHEET_ID && GOOGLE_ACCESS_TOKEN) {
    try {
      const result = await sheetsRequest('Jobs!A2:J');
      if (!result.values) return null;
      
      const row = result.values.find(r => r[0] === id);
      if (!row) return null;
      
      return {
        id: row[0],
        url: row[1],
        email: row[2],
        status: row[3],
        created_at: row[4],
        completed_at: row[5] || null,
        lighthouse_before: row[6] ? JSON.parse(row[6]) : null,
        lighthouse_after: row[7] ? JSON.parse(row[7]) : null,
        netlify_url: row[8] || null,
        notes: row[9] || null,
      };
    } catch (err) {
      console.error('[DB ERROR]', err);
    }
  }
  
  return memoryJobs.get(id) || null;
}

async function updateJobStatus(id, status) {
  if (SHEET_ID && GOOGLE_ACCESS_TOKEN) {
    try {
      // Find row index
      const result = await sheetsRequest('Jobs!A2:A');
      if (!result.values) return;
      
      const rowIndex = result.values.findIndex(r => r[0] === id);
      if (rowIndex === -1) return;
      
      await sheetsRequest(`Jobs!D${rowIndex + 2}`, 'PUT', {
        values: [[status]]
      });
      return;
    } catch (err) {
      console.error('[DB ERROR]', err);
    }
  }
  
  const job = memoryJobs.get(id);
  if (job) job.status = status;
}

async function saveLighthouseBefore(id, scores) {
  if (SHEET_ID && GOOGLE_ACCESS_TOKEN) {
    try {
      const result = await sheetsRequest('Jobs!A2:A');
      if (!result.values) return;
      
      const rowIndex = result.values.findIndex(r => r[0] === id);
      if (rowIndex === -1) return;
      
      await sheetsRequest(`Jobs!G${rowIndex + 2}`, 'PUT', {
        values: [[JSON.stringify(scores)]]
      });
      return;
    } catch (err) {
      console.error('[DB ERROR]', err);
    }
  }
  
  const job = memoryJobs.get(id);
  if (job) job.lighthouse_before = scores;
}

async function saveLighthouseAfter(id, scores) {
  if (SHEET_ID && GOOGLE_ACCESS_TOKEN) {
    try {
      const result = await sheetsRequest('Jobs!A2:A');
      if (!result.values) return;
      
      const rowIndex = result.values.findIndex(r => r[0] === id);
      if (rowIndex === -1) return;
      
      await sheetsRequest(`Jobs!H${rowIndex + 2}`, 'PUT', {
        values: [[JSON.stringify(scores)]]
      });
      return;
    } catch (err) {
      console.error('[DB ERROR]', err);
    }
  }
  
  const job = memoryJobs.get(id);
  if (job) job.lighthouse_after = scores;
}

async function completeJob(id, netlifyUrl, notes) {
  if (SHEET_ID && GOOGLE_ACCESS_TOKEN) {
    try {
      const result = await sheetsRequest('Jobs!A2:A');
      if (!result.values) return;
      
      const rowIndex = result.values.findIndex(r => r[0] === id);
      if (rowIndex === -1) return;
      
      await sheetsRequest(`Jobs!D${rowIndex + 2}:J${rowIndex + 2}`, 'PUT', {
        values: [['completed', new Date().toISOString(), null, null, netlifyUrl, notes]]
      });
      return;
    } catch (err) {
      console.error('[DB ERROR]', err);
    }
  }
  
  const job = memoryJobs.get(id);
  if (job) {
    job.status = 'completed';
    job.completed_at = new Date().toISOString();
    job.netlify_url = netlifyUrl;
    job.notes = notes;
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

    // Validate URL
    try {
      new URL(url);
    } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    // Validate Email
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
    
    // Send email
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

initSheet().then(() => {
  app.listen(PORT, () => {
    console.log(`[SERVER] Website Optimizer PROD running on port ${PORT}`);
  });
});