const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const app = express();
const STATIC_DIR = path.join(__dirname, 'static');
const ANSWERS_FILE = '/data/answers.json';
const MEMBERS_FILE = '/data/members.json';
const MEDIA_DIR = '/data/media';
const TMP_DIR = '/data/tmp';
const PASSWORD = process.env.APP_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || 'changeme-secret';
const WHISPER_URL = process.env.WHISPER_URL || 'http://speaches:8000';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'Systran/faster-whisper-small';
const TTS_URL = process.env.TTS_URL || 'http://speaches:8000';
const TTS_MODEL = process.env.TTS_MODEL || 'speaches-ai/Kokoro-82M-v1.0-ONNX';
const TTS_VOICE = process.env.TTS_VOICE || 'af_heart';

// Ensure media/tmp dirs exist at startup; clean up any leftover tmp chunks
fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.readdirSync(TMP_DIR).forEach(f => fs.rmSync(path.join(TMP_DIR, f), { recursive: true, force: true }));

app.set('trust proxy', 1); // nginx sits in front
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-eval'"], // unsafe-eval needed for dice-box WASM/Babylon shaders
      styleSrc:    ["'self'", "https://fonts.googleapis.com"],
      fontSrc:     ["'self'", "https://fonts.gstatic.com"],
      imgSrc:      ["'self'", "data:", "blob:"],
      mediaSrc:    ["'self'", "blob:"],
      workerSrc:   ["'self'", "blob:"],
      connectSrc:  ["'self'"],
    },
  },
}));
// General API rate limiter — applies to all /api/ routes
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  message: { error: 'Too many requests.' },
});

// Stricter limiter for login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many attempts. Try again later.' },
});

app.use('/api/', apiLimiter);
app.use(express.json({ limit: '32kb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// ── Auth endpoints (no auth required) ──────────────────────────────────────

app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const given = Buffer.from(password);
  const expected = Buffer.from(PASSWORD);
  const match = given.length === expected.length &&
    crypto.timingSafeEqual(given, expected);

  if (match) {
    req.session.authenticated = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ authenticated: !!req.session.authenticated });
});

// ── Auth middleware for everything else ────────────────────────────────────

function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  const PUBLIC_PATHS = [
    '/login.html', '/login.css', '/login.js', '/favicon.svg',
    '/manifest.json', '/service-worker.js', '/icon.svg', '/icon-maskable.svg',
  ];
  if (PUBLIC_PATHS.includes(req.path)) {
    return next();
  }
  res.redirect('/login.html');
}

app.use(requireAuth);

// ── Members API ────────────────────────────────────────────────────────────

function normalizeMembers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(m => typeof m === 'string' ? { name: m, dob: null } : m);
}

function loadMembers() {
  try { return normalizeMembers(JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8'))); }
  catch { return []; }
}

function saveMembers(members) {
  fs.mkdirSync(path.dirname(MEMBERS_FILE), { recursive: true });
  fs.writeFileSync(MEMBERS_FILE, JSON.stringify(members, null, 2));
}

function calcAge(dob) {
  if (!dob) return null;
  const birth = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

app.get('/api/members', (req, res) => {
  res.json(loadMembers());
});

const MAX_NAME_LEN = 80;

app.post('/api/members', (req, res) => {
  const { name, dob } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  if (name.trim().length > MAX_NAME_LEN) {
    return res.status(400).json({ error: 'Name too long' });
  }
  const members = loadMembers();
  const trimmed = name.trim();
  const idx = members.findIndex(m => m.name === trimmed);
  if (idx >= 0) {
    if (dob) members[idx].dob = dob;
  } else {
    members.push({ name: trimmed, dob: dob || null });
  }
  saveMembers(members);
  res.json({ ok: true });
});

// ── Answers API ────────────────────────────────────────────────────────────

function loadAnswers() {
  try { return JSON.parse(fs.readFileSync(ANSWERS_FILE, 'utf8')); }
  catch { return {}; }
}

function saveAnswers(answers) {
  fs.mkdirSync(path.dirname(ANSWERS_FILE), { recursive: true });
  fs.writeFileSync(ANSWERS_FILE, JSON.stringify(answers, null, 2));
}

// Normalize any legacy format to an array of { answer, author }
function normalizeEntries(entry) {
  if (!entry) return [];
  if (typeof entry === 'string') return [{ answer: entry, author: '' }];
  if (Array.isArray(entry)) return entry;
  return [{ answer: entry.answer || '', author: entry.author || '' }];
}

app.get('/api/answers', (req, res) => {
  const raw = loadAnswers();
  const normalized = {};
  for (const [id, entry] of Object.entries(raw)) {
    normalized[id] = normalizeEntries(entry);
  }
  res.json(normalized);
});

const VALID_QUESTION_ID = /^[a-zA-Z0-9_-]{1,64}$/;

app.get('/api/answers/:questionId', (req, res) => {
  if (!VALID_QUESTION_ID.test(req.params.questionId))
    return res.status(400).json({ error: 'Invalid question ID' });
  const answers = loadAnswers();
  res.json({ answers: normalizeEntries(answers[req.params.questionId]) });
});

const MAX_ANSWER_LEN = 10_000;
const VALID_MEDIA_PATH = /^media\/[a-zA-Z0-9_-]+\.(webm|m4a|jpg)$/;

app.post('/api/answers/:questionId', (req, res) => {
  if (!VALID_QUESTION_ID.test(req.params.questionId))
    return res.status(400).json({ error: 'Invalid question ID' });
  const { answer, author, audio, photos, forceNew } = req.body;
  if (typeof answer !== 'string') return res.status(400).json({ error: 'Invalid' });
  if (answer.length > MAX_ANSWER_LEN) return res.status(400).json({ error: 'Answer too long' });
  if (author && typeof author === 'string' && author.trim().length > MAX_NAME_LEN)
    return res.status(400).json({ error: 'Author name too long' });
  if (audio && !VALID_MEDIA_PATH.test(audio))
    return res.status(400).json({ error: 'Invalid audio path' });
  if (Array.isArray(photos) && photos.some(p => !VALID_MEDIA_PATH.test(p)))
    return res.status(400).json({ error: 'Invalid photo path' });
  const answers = loadAnswers();
  const entries = normalizeEntries(answers[req.params.questionId]);
  const authorKey = (author || '').trim();

  // Calculate age from stored dob at the moment of saving
  const members = loadMembers();
  const member = members.find(m => m.name === authorKey);
  const age = member ? calcAge(member.dob) : null;

  const entry = { answer, author: authorKey };
  if (age !== null) entry.age = age;
  if (audio) entry.audio = audio;
  if (Array.isArray(photos) && photos.length) entry.photos = photos;

  // forceNew = true → add alongside existing answers (multiple answers per author)
  // forceNew = false → replace all previous answers from this author
  const newEntries = forceNew === true
    ? [...entries, entry]
    : [...entries.filter(e => e.author !== authorKey), entry];

  answers[req.params.questionId] = newEntries;
  saveAnswers(answers);
  res.json({ ok: true });
});

app.delete('/api/answers/:questionId', (req, res) => {
  if (!VALID_QUESTION_ID.test(req.params.questionId))
    return res.status(400).json({ error: 'Invalid question ID' });
  const answers = loadAnswers();
  delete answers[req.params.questionId];
  saveAnswers(answers);
  res.json({ ok: true });
});

// ── Media upload (chunked) ─────────────────────────────────────────────────

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB per chunk max
});

async function transcribeAudio(filePath, filename, mimeType) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const blob = new Blob([fileBuffer], { type: mimeType || 'audio/webm' });
    const form = new FormData();
    form.append('file', blob, filename);
    form.append('model', WHISPER_MODEL);
    form.append('response_format', 'json');
    form.append('language', 'en');
    const res = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000), // 60 s max — large files can take time
    });
    if (!res.ok) throw new Error(`Whisper ${res.status}`);
    const data = await res.json();
    return data.text || null;
  } catch (e) {
    console.error('Transcription failed:', e.message);
    return null;
  }
}

const ALLOWED_MIME_TYPES = new Set([
  'audio/webm', 'audio/webm;codecs=opus', 'audio/mp4', 'audio/m4a',
  'image/jpeg', 'image/jpg',
]);
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100 MB total assembled file
const MAX_CHUNKS = 200;

app.post('/api/upload/chunk', chunkUpload.single('chunk'), async (req, res) => {
  const { uploadId, chunkIndex, totalChunks, mimeType } = req.body;

  // Prevent path traversal
  if (!uploadId || !/^[a-zA-Z0-9_-]+$/.test(uploadId)) {
    return res.status(400).json({ error: 'Invalid uploadId' });
  }
  if (!req.file) return res.status(400).json({ error: 'No chunk data' });

  // Validate mimeType against whitelist (check full string and base type)
  const baseMime = (mimeType || '').split(';')[0].trim();
  if (!ALLOWED_MIME_TYPES.has(mimeType) && !ALLOWED_MIME_TYPES.has(baseMime)) {
    return res.status(400).json({ error: 'Unsupported file type' });
  }

  const idx = parseInt(chunkIndex, 10);
  const total = parseInt(totalChunks, 10);

  if (!Number.isInteger(idx) || !Number.isInteger(total) || total < 1 || total > MAX_CHUNKS || idx < 0 || idx >= total) {
    return res.status(400).json({ error: 'Invalid chunk parameters' });
  }

  const tmpDir = path.join(TMP_DIR, uploadId);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Enforce total size cap: check accumulated size before writing
  const existingChunks = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [];
  const existingSize = existingChunks.reduce((sum, f) => sum + fs.statSync(path.join(tmpDir, f)).size, 0);
  if (existingSize + req.file.buffer.length > MAX_FILE_BYTES) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return res.status(413).json({ error: 'File too large' });
  }

  fs.writeFileSync(path.join(tmpDir, String(idx).padStart(6, '0')), req.file.buffer);

  if (idx < total - 1) {
    return res.json({ done: false });
  }

  // All chunks received — assemble
  const chunkFiles = fs.readdirSync(tmpDir).sort();
  const assembled = Buffer.concat(chunkFiles.map(f => fs.readFileSync(path.join(tmpDir, f))));
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const isAudio = mimeType && mimeType.startsWith('audio/');
  const ext = isAudio
    ? (mimeType.includes('mp4') || mimeType.includes('m4a') ? 'm4a' : 'webm')
    : 'jpg';
  const filename = `${uploadId}.${ext}`;
  const outPath = path.join(MEDIA_DIR, filename);
  fs.writeFileSync(outPath, assembled);

  let transcription = null;
  if (isAudio) {
    transcription = await transcribeAudio(outPath, filename, mimeType);
  }

  res.json({ done: true, path: `media/${filename}`, transcription });
});

// ── TTS proxy — streams speaches audio back to the browser ────────────────

app.get('/api/speak', async (req, res) => {
  const text = req.query.text;
  if (!text || typeof text !== 'string' || text.length > 2000) {
    return res.status(400).json({ error: 'Invalid text' });
  }
  try {
    const ttsRes = await fetch(`${TTS_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TTS_MODEL, input: text, voice: TTS_VOICE, response_format: 'mp3' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!ttsRes.ok) throw new Error(`TTS ${ttsRes.status}`);
    res.setHeader('Content-Type', 'audio/mpeg');
    Readable.fromWeb(ttsRes.body).pipe(res);
  } catch (e) {
    console.error('TTS failed:', e.message);
    if (!res.headersSent) res.status(502).json({ error: 'TTS unavailable' });
  }
});

// ── Media file serving (auth required — same middleware already applied above) ──

app.get('/media/:filename', (req, res) => {
  const filename = path.basename(req.params.filename); // strip any path components
  const filePath = path.join(MEDIA_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.sendFile(filePath);
});

// ── Static files ───────────────────────────────────────────────────────────

app.use(express.static(STATIC_DIR));

app.get('*', (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.listen(3000, () => console.log('Question Roller running on :3000'));
