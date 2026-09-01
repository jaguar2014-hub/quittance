/**
 * Quittances de Loyer — Serveur cloud (Render-compatible)
 *
 * - Sert le frontend HTML statique (GET /)
 * - API : /api/health, /api/locataires (GET/POST), /api/quittances (POST), /api/send
 * - OAuth Google : /auth/google/start, /auth/google/callback
 * - Whitelist emails (env GOOGLE_ALLOWED_EMAILS)
 * - Persistance disque : DATA_DIR/locataires.json + DATA_DIR/historique.json
 *
 * Variables d'environnement requises :
 *   - GMAIL_APP_PASSWORD : mot de passe d'application Gmail 16 chars
 *   - PUBLIC_BASE_URL : URL publique (ex: https://quittances-app.onrender.com)
 *   - GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET : depuis Google Cloud Console
 *   - GOOGLE_ALLOWED_EMAILS : emails autorisés, virgule-séparés
 *
 * Optionnel :
 *   - DATA_DIR : répertoire de stockage (défaut /data sur Render, . sinon)
 *   - PORT : port d'écoute (défaut 10000 sur Render, 8766 sinon)
 *   - SMTP_USER : défaut Jaguar2014@gmail.com
 */

const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8766', 10);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`;
const SMTP_USER = process.env.SMTP_USER || 'Jaguar2014@gmail.com';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const GMAIL_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ALLOWED_EMAILS = (process.env.GOOGLE_ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
const OAUTH_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && ALLOWED_EMAILS.length);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

// ============ Persistance disque ============

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); }
  catch (e) { console.error('DATA_DIR create error:', e.message); }
}

function readJson(filename, fallback) {
  const fp = path.join(DATA_DIR, filename);
  try {
    if (!fs.existsSync(fp)) return fallback;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  } catch { return fallback; }
}
function writeJson(filename, data) {
  ensureDataDir();
  const fp = path.join(DATA_DIR, filename);
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

// ============ SMTP ============

function buildTransport() {
  if (!GMAIL_PASSWORD) throw new Error('GMAIL_APP_PASSWORD non défini');
  return nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: true,
    auth: { user: SMTP_USER, pass: GMAIL_PASSWORD },
  });
}

async function sendMail({ to, subject, body, pdfBase64, filename }) {
  if (!to || !subject || !body || !pdfBase64 || !filename) {
    return { ok: false, error: 'Champs manquants : to, subject, body, pdfBase64, filename' };
  }
  try {
    const transport = buildTransport();
    const info = await transport.sendMail({
      from: SMTP_USER,
      to, subject, html: body,
      attachments: [{
        filename,
        content: Buffer.from(pdfBase64, 'base64'),
        contentType: 'application/pdf',
      }],
    });
    return { ok: true, messageId: info.messageId, response: info.response };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============ OAuth Google (PKCE S256) ============

const sessions = new Map(); // sessionId -> { userEmail, createdAt }
const oauthStates = new Map(); // state -> { verifier, createdAt }

function makeSessionId() { return crypto.randomBytes(24).toString('hex'); }
function makeState() { return crypto.randomBytes(16).toString('hex'); }
function makeVerifier() { return crypto.randomBytes(48).toString('base64url'); }
function makeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function cleanOldEntries(map, ttlMs) {
  const now = Date.now();
  for (const [k, v] of map.entries()) {
    if (now - v.createdAt > ttlMs) map.delete(k);
  }
}
setInterval(() => {
  cleanOldEntries(sessions, 24 * 60 * 60 * 1000);   // 24h
  cleanOldEntries(oauthStates, 10 * 60 * 1000);     // 10 min
}, 60 * 1000);

async function exchangeCodeForTokens(code, verifier) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: `${PUBLIC_BASE_URL}/auth/google/callback`,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  return res.json();
}

async function getUserinfo(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Userinfo failed: ${res.status}`);
  const j = await res.json();
  if (!j.email_verified) throw new Error('Email non vérifié par Google');
  return j;
}

// ============ Frontend statique ============

const ROOT = path.join(__dirname, '..');

function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  // Sert le frontend
  app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'quittances-app.html')));

  // Health
  app.get('/api/health', (req, res) => res.json({
    ok: true,
    oauth: OAUTH_ENABLED,
    dataDir: DATA_DIR,
    publicBaseUrl: PUBLIC_BASE_URL,
  }));

  // ============ AUTH ============

  app.get('/auth/google/start', (req, res) => {
    if (!OAUTH_ENABLED) return res.status(503).send('OAuth non configuré. Voir GOOGLE_OAUTH_SETUP.md');
    const state = makeState();
    const verifier = makeVerifier();
    oauthStates.set(state, { verifier, createdAt: Date.now() });
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: `${PUBLIC_BASE_URL}/auth/google/callback`,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      code_challenge: makeChallenge(verifier),
      code_challenge_method: 'S256',
      access_type: 'online',
      prompt: 'select_account',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  app.get('/auth/google/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`Google a refusé : ${error}`);
    if (!code || !state) return res.status(400).send('Code ou state manquant');
    const entry = oauthStates.get(state);
    if (!entry) return res.status(400).send('State invalide ou expiré');
    oauthStates.delete(state);
    try {
      const tokens = await exchangeCodeForTokens(code, entry.verifier);
      const user = await getUserinfo(tokens.access_token);
      if (!ALLOWED_EMAILS.includes(user.email)) {
        return res.status(403).send(`Accès refusé : ${user.email} n'est pas dans la liste blanche`);
      }
      const sid = makeSessionId();
      sessions.set(sid, { userEmail: user.email, createdAt: Date.now() });
      // Cookie httpOnly
      res.setHeader('Set-Cookie', `qsession=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400${PUBLIC_BASE_URL.startsWith('https') ? '; Secure' : ''}`);
      res.redirect('/?auth=ok');
    } catch (e) {
      res.status(500).send(`Erreur OAuth : ${e.message}`);
    }
  });

  app.post('/auth/logout', (req, res) => {
    const sid = req.headers.cookie?.match(/qsession=([^;]+)/)?.[1];
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'qsession=; HttpOnly; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  function authMiddleware(req, res, next) {
    if (!OAUTH_ENABLED) return next(); // dev: open access si OAuth non configuré
    const sid = req.headers.cookie?.match(/qsession=([^;]+)/)?.[1];
    const session = sid && sessions.get(sid);
    if (!session) return res.status(401).json({ ok: false, error: 'Non authentifié' });
    req.user = session;
    next();
  }

  app.get('/api/me', (req, res) => {
    if (!OAUTH_ENABLED) return res.json({ email: 'dev-mode', authenticated: true, oauthEnabled: false });
    const sid = req.headers.cookie?.match(/qsession=([^;]+)/)?.[1];
    const session = sid && sessions.get(sid);
    res.json({ email: session?.userEmail, authenticated: !!session, oauthEnabled: true });
  });

  // ============ API ============

  app.get('/api/locataires', authMiddleware, (req, res) => {
    res.json(readJson('locataires.json', []));
  });

  app.post('/api/locataires', authMiddleware, (req, res) => {
    const list = readJson('locataires.json', []);
    const { nom, email, adresse } = req.body || {};
    if (!nom || !email || !adresse) return res.status(400).json({ ok: false, error: 'Champs manquants' });
    list.push({ nom, email, adresse });
    writeJson('locataires.json', list);
    res.json({ ok: true, locataires: list });
  });

  app.get('/api/historique', authMiddleware, (req, res) => {
    res.json(readJson('historique.json', []));
  });

  app.post('/api/historique', authMiddleware, (req, res) => {
    const list = readJson('historique.json', []);
    list.unshift({ ...req.body, _by: req.user?.userEmail, _at: new Date().toISOString() });
    writeJson('historique.json', list.slice(0, 200));
    res.json({ ok: true });
  });

  app.post('/api/send', authMiddleware, async (req, res) => {
    const { to, subject, body, pdfBase64, filename } = req.body || {};
    if (!to || !subject || !body || !pdfBase64 || !filename) {
      return res.status(400).json({ ok: false, error: 'Champs manquants' });
    }
    const result = await sendMail({ to, subject, body, pdfBase64, filename });
    res.status(result.ok ? 200 : 500).json(result);
  });

  return app;
}

if (require.main === module) {
  ensureDataDir();
  const app = buildApp();
  app.listen(PORT, HOST, () => {
    console.log(`Quittances server listening on http://${HOST}:${PORT}`);
    console.log(`PUBLIC_BASE_URL = ${PUBLIC_BASE_URL}`);
    console.log(`OAuth = ${OAUTH_ENABLED ? 'ON' : 'OFF (dev mode)'} for ${ALLOWED_EMAILS.join(', ') || '(none)'}`);
    console.log(`DATA_DIR = ${DATA_DIR}`);
  });
}

module.exports = { buildApp, sendMail, readJson, writeJson };