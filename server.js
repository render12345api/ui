const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('frontend'));

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_cJi8CjrvmLH3@ep-square-recipe-a12q2cwj-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = 'burstsms_secret_2026';

// Warm up DB connection on startup so first login never fails
(async () => {
  for (let i = 0; i < 3; i++) {
    try { await pool.query('SELECT 1'); console.log('✅ DB connected'); break; }
    catch (e) { console.log(`DB warmup attempt ${i+1} failed, retrying...`); await new Promise(r => setTimeout(r, 2000)); }
  }
})();

// Auto-create blacklist table if not exists
pool.query(`CREATE TABLE IF NOT EXISTS blacklist (
  id SERIAL PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  added_at TIMESTAMP DEFAULT NOW()
)`).catch(e => console.error('Blacklist table init:', e));

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ─── SIGNUP ────────────────────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const exists = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });
    const hash = await bcrypt.hash(password, 10);
    const secret = require('crypto').randomBytes(16).toString('hex');
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, user_secret, credits, created_at, updated_at)
       VALUES ($1,$2,$3,2000,NOW(),NOW()) RETURNING id, email, credits`,
      [email, hash, secret]
    );
    const user = result.rows[0];
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email, credits: user.credits } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

// ─── LOGIN ─────────────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  // Retry up to 2 times in case of cold DB connection
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
      if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
      const user = result.rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
      const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({ token, user: { id: user.id, email: user.email, credits: user.credits } });
    } catch (e) {
      console.error(`Login attempt ${attempt} failed:`, e.message);
      if (attempt < 2) await new Promise(r => setTimeout(r, 1500)); // wait 1.5s then retry
      else return res.status(500).json({ error: 'Server error, please try again' });
    }
  }
});

// ─── ME ────────────────────────────────────────────────────────────────────────
app.get('/api/me', auth, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, email, credits, created_at FROM users WHERE id=$1', [req.user.id]);
    let burst_count = 0;
    try { const jc = await pool.query('SELECT COUNT(*) FROM jobs WHERE user_id=$1', [req.user.id]); burst_count = parseInt(jc.rows[0].count) || 0; } catch(_) {}
    res.json({ ...result.rows[0], burst_count });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ─── FIRE BURST ────────────────────────────────────────────────────────────────
app.post('/api/burst', auth, async (req, res) => {
  const { phone, delay, max_requests, mode } = req.body;
  try {
    const userRes = await pool.query('SELECT credits FROM users WHERE id=$1', [req.user.id]);
    const credits = userRes.rows[0].credits;
    if (credits < max_requests) {
      return res.status(402).json({ error: `Insufficient credits. You have ${credits}, need ${max_requests}` });
    }

    // Check if number is blacklisted
    const blCheck = await pool.query('SELECT 1 FROM blacklist WHERE phone=$1', [phone]).catch(_=>({rows:[]}));
    if (blCheck.rows.length) {
      return res.status(403).json({ error: 'This number is blacklisted and cannot be targeted.' });
    }

    // Call SMS burst API
    const response = await fetch('https://api.smsburst.online/api/job/start', {
      method: 'POST',
      headers: { 'X-API-Key': 'render123', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targets: [phone],        // e.g. "9977885544" — exactly as typed
        mode: mode || 'Normal',
        delay: parseFloat(delay),
        max_requests: parseInt(max_requests)
      })
    });
    const data = await response.json();
    const job_id = data.job_id || null;

    // Deduct credits
    await pool.query('UPDATE users SET credits=credits-$1, updated_at=NOW() WHERE id=$2', [max_requests, req.user.id]);

    // Log job — store external job_id for stop functionality
    try {
      await pool.query(
        `INSERT INTO jobs (user_id, target, mode, delay, max_requests, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [req.user.id, phone, mode, delay, max_requests, job_id ? `started:${job_id}` : 'started']
      );
    } catch(_) {}

    res.json({ success: true, job_id, credits_used: max_requests, credits_remaining: credits - max_requests });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error: ' + e.message }); }
});

// ─── STOP BURST ────────────────────────────────────────────────────────────────
app.post('/api/burst/stop', auth, async (req, res) => {
  const { job_id } = req.body;
  if (!job_id) return res.status(400).json({ error: 'job_id required' });
  try {
    const response = await fetch(`https://api.smsburst.online/api/job/${job_id}/stop`, {
      method: 'POST',
      headers: { 'X-API-Key': 'render123' }
    });
    const data = await response.json();
    res.json({ success: true, job_id, status: 'stopped', data });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error: ' + e.message }); }
});

// ─── BUY PLAN — NO AUTO ALLOCATION, just sends notification ───────────────────
app.post('/api/buy-plan', auth, async (req, res) => {
  const { plan } = req.body;
  const plans = {
    starter:  { credits: 8000,  price: 9 },
    pro:      { credits: 26000, price: 25 },
    advanced: { credits: 55000, price: 49 },
  };
  const chosen = plans[plan];
  if (!chosen) return res.status(400).json({ error: 'Invalid plan' });
  // Just log the purchase request — admin manually allocates after payment confirmation
  try {
    await pool.query(
      `INSERT INTO credit_transactions (user_id, amount, plan, created_at) VALUES ($1,$2,$3,NOW())`,
      [req.user.id, 0, `PENDING_${plan}`]   // amount=0 until admin confirms
    ).catch(_=>_);
    res.json({ success: true, message: 'Request received. Credits will be added after payment verification.' });
  } catch(e) { res.status(500).json({ error: 'Server error' }); }
});

// ─── HISTORY (burst deductions only) ─────────────────────────────────────────
app.get('/api/history', auth, async (req, res) => {
  try {
    const txns = [];
    // Burst deductions
    try {
      const jobs = await pool.query(
        `SELECT max_requests, target, created_at FROM jobs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`,
        [req.user.id]
      );
      jobs.rows.forEach(r => txns.push({
        type: 'burst',
        amount: r.max_requests,
        description: `Burst → ${r.target}`,
        created_at: r.created_at
      }));
    } catch(_) {}
    // Credit additions (manual admin allocations — amount > 0)
    try {
      const credits = await pool.query(
        `SELECT amount, plan, created_at FROM credit_transactions WHERE user_id=$1 AND amount > 0 ORDER BY created_at DESC LIMIT 20`,
        [req.user.id]
      );
      credits.rows.forEach(r => txns.push({
        type: 'credit',
        amount: r.amount,
        description: `Credits added — ${r.plan}`,
        created_at: r.created_at
      }));
    } catch(_) {}
    // Signup bonus
    try {
      const user = await pool.query('SELECT created_at FROM users WHERE id=$1', [req.user.id]);
      if (user.rows.length) txns.push({ type:'signup', amount:2000, description:'Signup bonus', created_at: user.rows[0].created_at });
    } catch(_) {}

    txns.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ transactions: txns });
  } catch(e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ BurstSMS running on http://localhost:${PORT}`));
