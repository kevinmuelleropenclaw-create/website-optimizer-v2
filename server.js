require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;

const app = express();

// Datenbank (lokale JSON-Datei als persistenter Speicher)
const DB_PATH = process.env.DB_PATH || './data/jobs.json';

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

// Admin: Complete Job (Ares sends email manually)
app.post('/api/jobs/:id/complete', requireAdminAuth, async (req, res) => {
  try {
    const { netlifyUrl, notes } = req.body;
    if (!netlifyUrl) return res.status(400).json({ error: 'netlifyUrl required' });
    
    const job = await getJobById(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    
    await completeJob(req.params.id, netlifyUrl, notes);
    const updatedJob = await getJobById(req.params.id);
    
    res.json({
      success: true,
      message: 'Job completed. Ares will send email manually.',
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