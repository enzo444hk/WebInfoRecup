/**
 * Veridia — serveur Node.js natif + nodemailer + node-cron
 *
 * - Inscription / connexion (mot de passe haché scrypt)
 * - Sessions cookie
 * - Journal d'événements live (SSE)
 * - Envoi automatique quotidien des logs par e-mail
 *
 * Variables d'environnement : voir .env.example
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

// Chargement optionnel de .env (sans dépendance dotenv)
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- Base de données fichier ----------
function loadDB() {
  if (!fs.existsSync(DATA_FILE)) return { users: [], events: [] };
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { users: [], events: [] };
  }
}
function saveDB(db) {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
let db = loadDB();

// ---------- Mots de passe (scrypt) ----------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex'));
}

// ---------- Cookies ----------
function parseCookies(header = '') {
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}
function addCookie(res, str) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', [str]);
  else if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, str]);
  else res.setHeader('Set-Cookie', [existing, str]);
}

// ---------- Sessions ----------
const sessions = new Map();
function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { userId, createdAt: Date.now() });
  return token;
}
function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.sid;
  if (!token || !sessions.has(token)) return null;
  return { token, ...sessions.get(token) };
}

// ---------- Identité invité ----------
function ensureGuestId(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  if (cookies.gid) return cookies.gid;
  const gid = crypto.randomBytes(4).toString('hex');
  addCookie(res, `gid=${gid}; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 365}`);
  return gid;
}

// ---------- SSE live ----------
const liveClients = new Set();
function broadcast(event) {
  const line = `[${new Date().toLocaleTimeString('fr-FR')}] ${event.label}`;
  console.log(line);
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of liveClients) {
    try { res.write(payload); } catch { /* client parti */ }
  }
}

function logEvent(type, message, meta, req, res) {
  const session = getSession(req);
  let userLabel;
  if (session) {
    const user = db.users.find((u) => u.id === session.userId);
    userLabel = user ? user.email : 'session inconnue';
  } else {
    const gid = ensureGuestId(req, res);
    userLabel = `invité-${gid}`;
  }
  const entry = {
    id: crypto.randomUUID(),
    type,
    message,
    meta: meta || {},
    user: userLabel,
    ts: new Date().toISOString(),
  };
  db.events.push(entry);
  if (db.events.length > 1000) db.events = db.events.slice(-1000);
  saveDB(db);
  broadcast({ label: `${entry.type.toUpperCase()} · ${entry.user} · ${entry.message}`, ...entry });
  return entry;
}

// ---------- HTTP helpers ----------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  const filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------- Email quotidien ----------
let nodemailer;
let cron;
try {
  nodemailer = require('nodemailer');
  cron = require('node-cron');
} catch (e) {
  console.warn('\n  ⚠  nodemailer ou node-cron manquant → lance `npm install`\n');
}

function buildEventsReport(hours = 24) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  const recent = db.events.filter((e) => new Date(e.ts).getTime() >= since);
  const lines = recent.map((e) => {
    const t = new Date(e.ts).toLocaleString('fr-FR', { timeZone: process.env.TZ || 'Europe/Paris' });
    return `[${t}] ${e.type.toUpperCase()} · ${e.user} · ${e.message}`;
  });
  return {
    count: recent.length,
    text:
      `Rapport Veridia — ${recent.length} événement(s) des dernières ${hours}h\n` +
      `Généré le ${new Date().toLocaleString('fr-FR', { timeZone: process.env.TZ || 'Europe/Paris' })}\n` +
      `────────────────────────────────────────\n\n` +
      (lines.length ? lines.join('\n') : '(aucun événement)') +
      `\n\n────────────────────────────────────────\nTotal comptes : ${db.users.length}\n`,
  };
}

async function sendDailyEmail() {
  const to = process.env.MAIL_TO;
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!to || !user || !pass) {
    console.log('[mail] Configuration incomplete (MAIL_TO / SMTP_USER / SMTP_PASS) → e-mail non envoyé');
    return { ok: false, error: 'config manquante' };
  }
  if (!nodemailer) {
    console.log('[mail] nodemailer non installé');
    return { ok: false, error: 'nodemailer manquant' };
  }

  const report = buildEventsReport(24);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass: pass.replace(/\s+/g, '') },
  });

  try {
    const info = await transporter.sendMail({
      from: `"Veridia Logs" <${from}>`,
      to,
      subject: `[Veridia] Rapport quotidien — ${report.count} événement(s)`,
      text: report.text,
    });
    console.log(`[mail] E-mail envoyé à ${to} (${report.count} événements) id=${info.messageId}`);
    return { ok: true, count: report.count };
  } catch (err) {
    console.error('[mail] Échec envoi :', err.message);
    return { ok: false, error: err.message };
  }
}

function startCron() {
  if (!cron) return;
  const expr = process.env.MAIL_CRON || '0 8 * * *';
  if (!cron.validate(expr)) {
    console.warn(`[mail] Expression cron invalide : ${expr}`);
    return;
  }
  cron.schedule(
    expr,
    () => {
      console.log('[mail] Déclenchement envoi quotidien…');
      sendDailyEmail();
    },
    { timezone: process.env.TZ || 'Europe/Paris' }
  );
  console.log(`  E-mail quotidien programmé : "${expr}" (${process.env.TZ || 'Europe/Paris'}) → ${process.env.MAIL_TO || '(non configuré)'}`);
}

// ---------- Serveur HTTP ----------
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsed.pathname;

  // SSE
  if (pathname === '/api/stream' && req.method === 'GET') {
    ensureGuestId(req, res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    liveClients.add(res);
    req.on('close', () => liveClients.delete(res));
    return;
  }

  if (pathname === '/api/register' && req.method === 'POST') {
    const { email, password } = await readBody(req);
    if (!email || !password || password.length < 6) {
      return sendJSON(res, 400, {
        ok: false,
        error: 'E-mail invalide ou mot de passe trop court (6 caractères min).',
      });
    }
    if (db.users.find((u) => u.email === email.toLowerCase())) {
      return sendJSON(res, 409, { ok: false, error: 'Un compte existe déjà avec cet e-mail.' });
    }
    const user = {
      id: crypto.randomUUID(),
      email: email.toLowerCase(),
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    saveDB(db);
    logEvent('auth', `compte créé (${user.email})`, {}, req, res);
    const token = createSession(user.id);
    addCookie(res, `sid=${token}; HttpOnly; Path=/; SameSite=Lax`);
    return sendJSON(res, 200, { ok: true, user: { email: user.email } });
  }

  if (pathname === '/api/login' && req.method === 'POST') {
    const { email, password } = await readBody(req);
    const user = db.users.find((u) => u.email === (email || '').toLowerCase());
    if (!user || !verifyPassword(password || '', user.passwordHash)) {
      logEvent('auth-fail', `tentative de connexion refusée (${email || 'inconnu'})`, {}, req, res);
      return sendJSON(res, 401, { ok: false, error: 'E-mail ou mot de passe incorrect.' });
    }
    logEvent('auth', `connexion réussie (${user.email})`, {}, req, res);
    const token = createSession(user.id);
    addCookie(res, `sid=${token}; HttpOnly; Path=/; SameSite=Lax`);
    return sendJSON(res, 200, { ok: true, user: { email: user.email } });
  }

  if (pathname === '/api/logout' && req.method === 'POST') {
    const session = getSession(req);
    if (session) sessions.delete(session.token);
    addCookie(res, 'sid=; HttpOnly; Path=/; Max-Age=0');
    return sendJSON(res, 200, { ok: true });
  }

  if (pathname === '/api/me' && req.method === 'GET') {
    const session = getSession(req);
    if (!session) return sendJSON(res, 401, { ok: false });
    const user = db.users.find((u) => u.id === session.userId);
    return sendJSON(res, 200, { ok: true, user: { email: user?.email } });
  }

  if (pathname === '/api/telemetry' && req.method === 'POST') {
    const { type, message, meta } = await readBody(req);
    const entry = logEvent(type || 'info', message || '', meta, req, res);
    return sendJSON(res, 200, { ok: true, entry });
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    return sendJSON(res, 200, { ok: true, events: db.events.slice(-100) });
  }

  // Endpoint manuel pour tester l'envoi d'e-mail (protégé par un secret optionnel)
  if (pathname === '/api/send-report' && req.method === 'POST') {
    const body = await readBody(req);
    const secret = process.env.ADMIN_SECRET;
    if (secret && body.secret !== secret) {
      return sendJSON(res, 403, { ok: false, error: 'secret invalide' });
    }
    const result = await sendDailyEmail();
    return sendJSON(res, result.ok ? 200 : 500, result);
  }

  if (req.method === 'GET') return serveStatic(req, res, pathname);

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\n  Portail Veridia en écoute sur http://localhost:${PORT}\n`);
  console.log('  Les événements s\'affichent ici et dans le panneau de la page (SSE).');
  startCron();
  console.log('');
});
