require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const lighthouse = require('lighthouse');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const app = express();

// Database Setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Gmail OAuth2 Setup
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

// ==================== DATABASE FUNCTIONS ====================

async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        url TEXT NOT NULL,
        email TEXT NOT NULL,
        status TEXT DEFAULT 'submitted',
        created_at TIMESTAMP DEFAULT NOW(),
        completed_at TIMESTAMP,
        lighthouse_before JSONB,
        lighthouse_after JSONB,
        netlify_url TEXT,
        notes TEXT,
        html_content TEXT
      )
    `);
    console.log('[DB] Initialized');
  } finally {
    client.release();
  }
}

async function createJob(url, email) {
  const result = await pool.query(
    'INSERT INTO jobs (url, email, status) VALUES ($1, $2, $3) RETURNING *',
    [url, email, 'submitted']
  );
  return result.rows[0];
}

async function getPendingJobs() {
  const result = await pool.query(
    'SELECT * FROM jobs WHERE status = $1 ORDER BY created_at DESC',
    ['submitted']
  );
  return result.rows;
}

async function getJobById(id) {
  const result = await pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  return result.rows[0];
}

async function updateJobStatus(id, status) {
  await pool.query('UPDATE jobs SET status = $1 WHERE id = $2', [status, id]);
}

async function saveLighthouseBefore(id, scores) {
  await pool.query('UPDATE jobs SET lighthouse_before = $1 WHERE id = $2', [JSON.stringify(scores), id]);
}

async function saveLighthouseAfter(id, scores) {
  await pool.query('UPDATE jobs SET lighthouse_after = $1 WHERE id = $2', [JSON.stringify(scores), id]);
}

async function completeJob(id, netlifyUrl, notes, htmlContent) {
  await pool.query(
    'UPDATE jobs SET status = $1, completed_at = NOW(), netlify_url = $2, notes = $3, html_content = $4 WHERE id = $5',
    ['completed', netlifyUrl, notes, htmlContent, id]
  );
}

// ==================== LIGHTHOUSE ASSESSMENT ====================

async function runLighthouse(url) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const result = await lighthouse(url, {
      port: new URL(browser.wsEndpoint()).port,
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    });
    
    return {
      performance: Math.round(result.lhr.categories.performance.score * 100),
      accessibility: Math.round(result.lhr.categories.accessibility.score * 100),
      bestPractices: Math.round(result.lhr.categories['best-practices'].score * 100),
      seo: Math.round(result.lhr.categories.seo.score * 100),
      url: url,
      timestamp: new Date().toISOString()
    };
  } finally {
    await browser.close();
  }
}

// ==================== NETLIFY DEPLOYMENT ====================

async function deployToNetlify(siteName, htmlContent) {
  const tempDir = `/tmp/netlify-deploy-${Date.now()}`;
  
  try {
    // Create temp directory with files
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, 'index.html'), htmlContent);
    
    // Deploy using Netlify CLI
    const { stdout } = await execPromise(
      `npx netlify deploy --prod --dir=${tempDir} --site=${siteName} --auth=${process.env.NETLIFY_TOKEN} --json`,
      { timeout: 120000 }
    );
    
    const deployInfo = JSON.parse(stdout);
    return deployInfo.deploy_url;
  } catch (error) {
    console.error('[NETLIFY ERROR]', error);
    throw error;
  } finally {
    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });
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
            <strong>Interessiert?</strong> Antworte einfach auf diese E-Mail oder besuche unsere Website.
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
    const result = await pool.query('SELECT * FROM jobs ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Run Lighthouse Before
app.post('/api/jobs/:id/lighthouse-before', requireAdminAuth, async (req, res) => {
  try {
    const job = await getJobById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    await updateJobStatus(req.params.id, 'processing');
    const scores = await runLighthouse(job.url);
    await saveLighthouseBefore(req.params.id, scores);
    
    res.json({ success: true, scores });
  } catch (err) {
    console.error('[LIGHTHOUSE ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: Run Lighthouse After
app.post('/api/jobs/:id/lighthouse-after', requireAdminAuth, async (req, res) => {
  try {
    const { netlifyUrl } = req.body;
    if (!netlifyUrl) return res.status(400).json({ error: 'netlifyUrl required' });
    
    const scores = await runLighthouse(netlifyUrl);
    await saveLighthouseAfter(req.params.id, scores);
    
    res.json({ success: true, scores });
  } catch (err) {
    console.error('[LIGHTHOUSE ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// Admin: Complete Job
app.post('/api/jobs/:id/complete', requireAdminAuth, async (req, res) => {
  try {
    const { netlifyUrl, notes, htmlContent } = req.body;
    if (!netlifyUrl) return res.status(400).json({ error: 'netlifyUrl required' });
    
    const job = await getJobById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    await completeJob(req.params.id, netlifyUrl, notes, htmlContent);
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

// Admin: Deploy to Netlify
app.post('/api/jobs/:id/deploy', requireAdminAuth, async (req, res) => {
  try {
    const { htmlContent, siteName } = req.body;
    if (!htmlContent || !siteName) {
      return res.status(400).json({ error: 'htmlContent and siteName required' });
    }
    
    const deployUrl = await deployToNetlify(siteName, htmlContent);
    
    res.json({ success: true, deployUrl });
  } catch (err) {
    console.error('[DEPLOY ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start Server
const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`[SERVER] Website Optimizer PROD running on port ${PORT}`);
  });
}).catch(err => {
  console.error('[FATAL] Database init failed:', err);
  process.exit(1);
});