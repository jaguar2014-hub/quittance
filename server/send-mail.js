/**
 * Quittances de Loyer — Serveur cloud (Render-compatible)
 *
 * - Sert le frontend HTML statique (GET /)
 * - API : /api/health, /api/locataires (GET/POST), /api/quittances (POST), /api/send
 * - OAuth Google : /auth/google/start, /auth/google/callback
 * - Whitelist emails (env GOOGLE_ALLOWED_EMAILS)
 * - Persistance disque : DATA_DIR/locataires.json + DATA_DIR/historique.json + DATA_DIR/profil.json
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
  *   - SMTP_USER : défaut '' (lu depuis le profil bailleur)
  *   - APP_LOGIN_EMAIL + APP_LOGIN_PASSWORD (+ optionnel APP_LOGIN_PASSWORD_HASH) :
  *       active un login email/password simple (alternative à OAuth Google).
  *       Si APP_LOGIN_EMAIL est non vide → auth obligatoire sur les routes /api/*
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
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '465', 10);
const GMAIL_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const ALLOWED_EMAILS = (process.env.GOOGLE_ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
const OAUTH_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && ALLOWED_EMAILS.length);

// ============ Login simple (Brief E) ============
const APP_LOGIN_EMAIL = (process.env.APP_LOGIN_EMAIL || '').trim().toLowerCase();
const APP_LOGIN_PASSWORD = process.env.APP_LOGIN_PASSWORD || '';
const APP_LOGIN_PASSWORD_HASH = (process.env.APP_LOGIN_PASSWORD_HASH || '').trim().toLowerCase();
const PASSWORD_AUTH_ENABLED = !!APP_LOGIN_EMAIL && (!!APP_LOGIN_PASSWORD || !!APP_LOGIN_PASSWORD_HASH);
const AUTH_REQUIRED = OAUTH_ENABLED || PASSWORD_AUTH_ENABLED;

function sha256Hex(s) {
   return crypto.createHash('sha256').update(String(s)).digest('hex');
 }
function passwordMatches(input) {
   const candidate = String(input || '');
   if (APP_LOGIN_PASSWORD_HASH) {
     return sha256Hex(candidate) === APP_LOGIN_PASSWORD_HASH;
   }
   return candidate === APP_LOGIN_PASSWORD;
 }

// Rate limit login (RAM): 5 tentatives / 15 min / IP
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const loginAttempts = new Map();
function clientIp(req) {
   return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').toString().split(',')[0].trim();
 }
function pruneAttempts(ip, now) {
   const arr = loginAttempts.get(ip);
   if (!arr) return;
   const fresh = arr.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
   if (fresh.length === 0) loginAttempts.delete(ip); else loginAttempts.set(ip, fresh);
 }
function recordAttempt(ip, now) {
   const arr = loginAttempts.get(ip) || [];
   arr.push(now);
   loginAttempts.set(ip, arr);
 }
function isRateLimited(ip) {
   const now = Date.now();
   pruneAttempts(ip, now);
   const arr = loginAttempts.get(ip) || [];
   return arr.length >= RATE_LIMIT_MAX;
 }

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

// ============ Profil bailleur (Brief E) ============

const DEFAULT_PROFIL = {
  nom: '',
  email: '',
  adresse: '',
  telephone: '',
  lieuDefaut: '',
};

function sanitizeProfil(input) {
  const p = input && typeof input === 'object' ? input : {};
  const email = typeof p.email === 'string' ? p.email.trim() : '';
  // Validation email (présence @ et .) — on est permissif, juste pour éviter les typos
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw Object.assign(new Error('Email invalide : ' + email), { status: 400 });
  }
  return {
    nom: typeof p.nom === 'string' ? p.nom.trim() : '',
    email,
    adresse: typeof p.adresse === 'string' ? p.adresse.trim() : '',
    telephone: typeof p.telephone === 'string' ? p.telephone.trim() : '',
    lieuDefaut: typeof p.lieuDefaut === 'string' ? p.lieuDefaut.trim() : '',
  };
}

function readProfil() {
  const p = readJson('profil.json', null);
  return p ? sanitizeProfil(p) : { ...DEFAULT_PROFIL };
}

function resolveFrom() {
  // Le mail part au nom du bailleur : on lit le profil, sinon SMTP_USER
  const p = readProfil();
  return p.email || SMTP_USER || '';
}

// ============ SMTP ============

function buildTransport() {
  if (!GMAIL_PASSWORD) throw new Error('GMAIL_APP_PASSWORD non défini');
  const fromUser = resolveFrom() || SMTP_USER;
  return nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: true,
    auth: { user: fromUser, pass: GMAIL_PASSWORD },
  });
}

async function sendMail({ to, subject, body, pdfBase64, filename, from }) {
  if (!to || !subject || !body || !pdfBase64 || !filename) {
    return { ok: false, error: 'Champs manquants : to, subject, body, pdfBase64, filename' };
  }
  try {
    const transport = buildTransport();
    // Empreinte SHA-256 du PDF (signature numérique, loi ELAN)
    const pdfBuf = Buffer.from(pdfBase64, 'base64');
    const sha256Hex = crypto.createHash('sha256').update(pdfBuf).digest('hex');
    // from : argument explicite > profil.email > SMTP_USER > placeholder
    const mailFrom = from || resolveFrom() || SMTP_USER || 'quittances@localhost';
    const info = await transport.sendMail({
      from: mailFrom,
      to, subject, html: body,
      attachments: [{
        filename,
        content: pdfBuf,
        contentType: 'application/pdf',
        // Header RFC pour exposer le hash aux clients mail (vérification externe)
        headers: { 'X-PDF-SHA256': sha256Hex },
      }],
    });
    return { ok: true, messageId: info.messageId, response: info.response, sha256: sha256Hex, from: mailFrom };
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

  // Sert le frontend (racine = fichier HTML, le reste via static)
  app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'quittances-app.html')));
  // Sert les fichiers statiques (manifest.webmanifest, sw.js, icons/, etc.)
  app.use(express.static(ROOT, { extensions: ['html'] }));

  // Health
    app.get('/api/health', (req, res) => res.json({
      ok: true,
      oauth: OAUTH_ENABLED,
      loginConfigured: PASSWORD_AUTH_ENABLED,
      authRequired: AUTH_REQUIRED,
      dataDir: DATA_DIR,
      publicBaseUrl: PUBLIC_BASE_URL,
    }));

  // ============ AUTH ============

  // Émet un cookie qsession pour un email donné (utilisé par OAuth + login simple)
  function issueSessionCookie(res, email) {
      const sid = makeSessionId();
      sessions.set(sid, { userEmail: email, createdAt: Date.now() });
      res.setHeader('Set-Cookie',
        `qsession=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=86400${PUBLIC_BASE_URL.startsWith('https') ? '; Secure' : ''}`);
      return sid;
    }

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
      issueSessionCookie(res, user.email);
      res.redirect('/?auth=ok');
    } catch (e) {
      res.status(500).send(`Erreur OAuth : ${e.message}`);
    }
  });

  // ============ Login email/password (Brief E) ============

  app.post('/auth/login', (req, res) => {
    const ip = clientIp(req);
    if (isRateLimited(ip)) {
      return res.status(429).json({ ok: false, error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
    }
    if (!PASSWORD_AUTH_ENABLED) {
      recordAttempt(ip, Date.now());
      return res.status(503).json({ ok: false, error: 'Login email/password non configuré (APP_LOGIN_EMAIL manquant).' });
    }
    const { email, password } = req.body || {};
    if (!email || !password) {
      recordAttempt(ip, Date.now());
      return res.status(400).json({ ok: false, error: 'Champs requis : email, password' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    if (emailNorm !== APP_LOGIN_EMAIL || !passwordMatches(password)) {
      recordAttempt(ip, Date.now());
      return res.status(401).json({ ok: false, error: 'Email ou mot de passe invalide' });
    }
    issueSessionCookie(res, APP_LOGIN_EMAIL);
    res.json({ ok: true, email: APP_LOGIN_EMAIL });
  });

  app.post('/auth/logout', (req, res) => {
    const sid = req.headers.cookie?.match(/qsession=([^;]+)/)?.[1];
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'qsession=; HttpOnly; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  function authMiddleware(req, res, next) {
      if (!AUTH_REQUIRED) return next(); // dev: open access si aucune auth configurée
      const sid = req.headers.cookie?.match(/qsession=([^;]+)/)?.[1];
      const session = sid && sessions.get(sid);
      if (!session) return res.status(401).json({ ok: false, error: 'Non authentifié' });
      req.user = session;
      next();
    }

    app.get('/api/me', (req, res) => {
      if (!AUTH_REQUIRED) {
        return res.json({ email: 'dev-mode', authenticated: true, oauthEnabled: false, loginEnabled: false });
      }
      const sid = req.headers.cookie?.match(/qsession=([^;]+)/)?.[1];
      const session = sid && sessions.get(sid);
      res.json({
        email: session?.userEmail,
        authenticated: !!session,
        oauthEnabled: OAUTH_ENABLED,
        loginEnabled: PASSWORD_AUTH_ENABLED,
      });
    });

  // ============ API Profil bailleur (Brief E) ============

  app.get('/api/profil', authMiddleware, (req, res) => {
    res.json(readProfil());
  });

  app.post('/api/profil', authMiddleware, (req, res) => {
    try {
      const clean = sanitizeProfil(req.body);
      writeJson('profil.json', clean);
      res.json({ ok: true, profil: clean });
    } catch (e) {
      const status = e.status || 500;
      res.status(status).json({ ok: false, error: e.message });
    }
  });

  // ============ API ============


  app.get('/api/locataires', authMiddleware, (req, res) => {
    res.json(readJson('locataires.json', []));
  });

  app.post('/api/locataires', authMiddleware, (req, res) => {
      const list = readJson('locataires.json', []);
      const body = req.body || {};
      const { prenom, nom, email, adresse, loyerHC, charges, dateEntree, bailRef } = body;
      // Champs obligatoires (rétro-compat Briefs précédents)
      if (!nom || !email || !adresse) return res.status(400).json({ ok: false, error: 'Champs manquants : nom, email, adresse' });
      // Champs optionnels Brief A — valeurs par défaut si absents (rétro-compat)
      const entry = {
        id: 'loc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        prenom: prenom || '',
        nom: String(nom),
        email: String(email),
        adresse: typeof adresse === 'string'
          ? adresse
          : {
              rue: adresse.rue || '',
              complement: adresse.complement || '',
              cp: adresse.cp || '',
              ville: adresse.ville || '',
            },
        loyerHC: typeof loyerHC === 'number' ? loyerHC : null,
        charges: typeof charges === 'number' ? charges : null,
        dateEntree: dateEntree || null,
        bailRef: bailRef || null,
        creeLe: new Date().toISOString(),
      };
      list.push(entry);
      writeJson('locataires.json', list);
      res.json({ ok: true, locataires: list, id: entry.id });
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
    const { to, subject, body, pdfBase64, filename, from } = req.body || {};
    if (!to || !subject || !body || !pdfBase64 || !filename) {
      return res.status(400).json({ ok: false, error: 'Champs manquants' });
    }
    const result = await sendMail({ to, subject, body, pdfBase64, filename, from });
    res.status(result.ok ? 200 : 500).json(result);
  });

  // ============ API Template (Brief B) ============

  const DEFAULT_TEMPLATE = {
      proprietaire: {
        nom: '',
        adresse: '',
        telephone: '',
        email: '',
      },
      mentionLegale: "Cette quittance annule tous les reçus qui auraient pu être établis précédemment en cas de paiement partiel du montant du présent terme. Elle est à conserver pendant trois ans par le locataire (article 7-1 de la loi n° 89-462 du 6 juillet 1989).",
      lieuDefaut: '',
      signatureLabel: 'Le bailleur',
      signatureLoiElan: true,
      logoUrl: null,
    };

  function sanitizeTemplate(input) {
    const t = input && typeof input === 'object' ? input : {};
    const p = (t.proprietaire && typeof t.proprietaire === 'object') ? t.proprietaire : {};
    return {
      proprietaire: {
        nom: typeof p.nom === 'string' ? p.nom : DEFAULT_TEMPLATE.proprietaire.nom,
        adresse: typeof p.adresse === 'string' ? p.adresse : DEFAULT_TEMPLATE.proprietaire.adresse,
        telephone: typeof p.telephone === 'string' ? p.telephone : DEFAULT_TEMPLATE.proprietaire.telephone,
        email: typeof p.email === 'string' ? p.email : DEFAULT_TEMPLATE.proprietaire.email,
      },
      mentionLegale: typeof t.mentionLegale === 'string' ? t.mentionLegale : DEFAULT_TEMPLATE.mentionLegale,
      lieuDefaut: typeof t.lieuDefaut === 'string' ? t.lieuDefaut : DEFAULT_TEMPLATE.lieuDefaut,
      signatureLabel: typeof t.signatureLabel === 'string' ? t.signatureLabel : DEFAULT_TEMPLATE.signatureLabel,
      signatureLoiElan: t.signatureLoiElan === false ? false : true,
      logoUrl: (typeof t.logoUrl === 'string' && t.logoUrl) ? t.logoUrl : null,
    };
  }

  app.get('/api/template', authMiddleware, (req, res) => {
    const t = readJson('template.json', null);
    res.json(t || DEFAULT_TEMPLATE);
  });

  app.post('/api/template', authMiddleware, (req, res) => {
    const clean = sanitizeTemplate(req.body);
    writeJson('template.json', clean);
    res.json({ ok: true, template: clean });
  });

  // ============ API Paiements (Brief B) ============

  function readPaiements() { return readJson('paiements.json', []); }
  function writePaiements(list) { writeJson('paiements.json', list); }

  function makePmtId(locataireId, mois, annee) {
    const slug = String(mois).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return `pmt_${annee}_${slug}_${crypto.randomBytes(3).toString('hex')}`;
  }

  app.get('/api/paiements/:locataireId', authMiddleware, (req, res) => {
    const lid = String(req.params.locataireId || '');
    const all = readPaiements();
    const list = all.filter((p) => p.locataireId === lid);
    res.json(list);
  });


  app.post('/api/paiements', authMiddleware, (req, res) => {
    const body = req.body || {};
    const { locataireId, mois, annee, total, statut, datePaiement, dateEnvoiQuittance, pdfSha256, id } = body;
    if (!locataireId || !mois || !annee || !statut) {
      return res.status(400).json({ ok: false, error: 'Champs requis : locataireId, mois, annee, statut' });
    }
    const VALID_STATUTS = ['en_attente', 'paye', 'impaye', 'quittance_envoyee'];
    if (!VALID_STATUTS.includes(statut)) {
      return res.status(400).json({ ok: false, error: 'statut invalide (attendu: ' + VALID_STATUTS.join(', ') + ')' });
    }
    const all = readPaiements();
    const existingIdx = id
      ? all.findIndex((p) => p.id === id)
      : all.findIndex((p) => p.locataireId === locataireId && p.mois === mois && p.annee === annee);
    const entry = { id: existingIdx >= 0 ? all[existingIdx].id : makePmtId(locataireId, mois, annee), locataireId, mois, annee, statut };
    if (typeof total === 'number') entry.total = total;
    if (datePaiement) entry.datePaiement = datePaiement;
    if (dateEnvoiQuittance) entry.dateEnvoiQuittance = dateEnvoiQuittance;
    if (pdfSha256) entry.pdfSha256 = pdfSha256;
    if (existingIdx >= 0) all[existingIdx] = entry; else all.push(entry);
    writePaiements(all);
    res.json({ ok: true, paiement: entry });
  });

  // ============ API Envoi en un clic (Brief C) ============

  // Résout un locataireId (string) vers l'objet locataire correspondant.
  // Le frontend peut envoyer :
  //   - un id custom (ex: "loc_2024_01_xyz") → match direct sur .id
  //   - un id de fallback côté UI ("loc_idx_<N>") → match par index dans le tableau
  function findLocataire(locataireId) {
    const list = readJson('locataires.json', []);
    const direct = list.find(x => x && x.id === locataireId);
    if (direct) return direct;
    const m = typeof locataireId === 'string' && locataireId.match(/^loc_idx_(\d+)$/);
    if (m) {
      const idx = parseInt(m[1], 10);
      if (idx >= 0 && idx < list.length) return list[idx];
    }
    return null;
  }

  function adresseLocataire(l) {
    if (!l) return '';
    if (typeof l.adresse === 'string') return l.adresse;
    if (l.adresse && typeof l.adresse === 'object') {
      const a = l.adresse;
      return [a.rue, a.complement, [a.cp, a.ville].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    }
    return '';
  }

  app.post('/api/paiements/envoyer', authMiddleware, async (req, res) => {
    const body = req.body || {};
    const { paiementId, locataireId } = body;
    if (!paiementId || !locataireId) {
      return res.status(400).json({ ok: false, error: 'Champs requis : paiementId, locataireId' });
    }

    // 1. Trouver le paiement
    const allPaiements = readPaiements();
    const pmtIdx = allPaiements.findIndex(p => p.id === paiementId);
    if (pmtIdx < 0) {
      return res.status(404).json({ ok: false, error: 'Paiement introuvable : ' + paiementId });
    }
    const paiement = allPaiements[pmtIdx];

    // 2. Trouver le locataire
    const loc = findLocataire(locataireId);
    if (!loc) {
      return res.status(404).json({ ok: false, error: 'Locataire introuvable : ' + locataireId });
    }
    if (!loc.email) {
      return res.status(400).json({ ok: false, error: 'Locataire sans email' });
    }

    // 3. Charger le template (propriétaire + lieuDefaut) puis le profil (Brief E)
    //    Le profil a priorité sur le template pour nom, email, lieu.
    const tpl = readJson('template.json', null) || DEFAULT_TEMPLATE;
    const profil = readProfil();
    const proprietaireNom = (profil && profil.nom) || (tpl.proprietaire && tpl.proprietaire.nom) || '';
    const lieuDefaut = (profil && profil.lieuDefaut) || tpl.lieuDefaut || '';

    // 4. Construire les données du PDF
    const loyerHC = (typeof loc.loyerHC === 'number') ? loc.loyerHC : 0;
    const charges = (typeof loc.charges === 'number') ? loc.charges : 0;
    const total = (typeof paiement.total === 'number') ? paiement.total : (loyerHC + charges);

    const dateEm = new Date();
    const dd = String(dateEm.getDate()).padStart(2, '0');
    const mm = String(dateEm.getMonth() + 1).padStart(2, '0');
    const yyyy = dateEm.getFullYear();
    const dateEmission = `${dd}/${mm}/${yyyy}`;

    const pdfData = {
      proprietaire: proprietaireNom,
      locataire: (loc.prenom || loc.nom) ? { prenom: loc.prenom || '', nom: loc.nom || '' } : (loc.nom || ''),
      adresse: adresseLocataire(loc),
      mois: paiement.mois,
      annee: paiement.annee,
      loyerHC,
      charges,
      total,
      lieu: lieuDefaut,
      dateEmission,
    };

    // 5. Générer le PDF
    let pdfBuffer;
    try {
      const pdfEngine = require('../pdf-engine');
      pdfBuffer = pdfEngine.buildPdf(pdfData);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'Génération PDF échouée : ' + e.message });
    }

    // 6. SHA-256 du PDF
    const sha256 = crypto.createHash('sha256').update(pdfBuffer).digest('hex');

    // 7. Nom de fichier
    let filename;
    try {
      const pdfEngine = require('../pdf-engine');
      filename = pdfEngine.buildFilename({
        locataire: (loc.prenom ? loc.prenom + ' ' : '') + (loc.nom || ''),
        mois: paiement.mois,
        annee: paiement.annee,
      });
    } catch (e) {
      filename = `quittance-${paiement.annee}-${String(paiement.mois).toLowerCase()}.pdf`;
    }

    // 8. Envoi SMTP (sendMail attend pdfBase64 — on encode depuis le buffer généré)
    const pdfBase64 = pdfBuffer.toString('base64');
    const mailResult = await sendMail({
      to: loc.email,
      subject: `Quittance de loyer — ${paiement.mois} ${paiement.annee}`,
      body: '<p>Bonjour,</p><p>Veuillez trouver ci-joint votre quittance de loyer pour ' + paiement.mois + ' ' + paiement.annee + '.</p><p>Cordialement</p>',
      pdfBase64,
      filename,
      from: (profil && profil.email) || SMTP_USER || '',
    });

    if (!mailResult.ok) {
      return res.status(500).json({ ok: false, error: mailResult.error || 'Échec envoi SMTP' });
    }

    // 9. Mettre à jour le paiement
    const updated = {
      ...paiement,
      statut: 'quittance_envoyee',
      dateEnvoiQuittance: new Date().toISOString(),
      pdfSha256: sha256,
    };
    allPaiements[pmtIdx] = updated;
    writePaiements(allPaiements);

    // 10. Retour
    res.json({
      ok: true,
      sha256,
      filename,
      messageId: mailResult.messageId,
      from: mailResult.from,
      paiement: updated,
    });
  });

  return app;
}


if (require.main === module) {
  ensureDataDir();
  const app = buildApp();
  app.listen(PORT, HOST, () => {
    console.log(`Quittances server listening on http://${HOST}:${PORT}`);
    console.log(`PUBLIC_BASE_URL = ${PUBLIC_BASE_URL}`);
    console.log(`OAuth = ${OAUTH_ENABLED ? 'ON' : 'OFF'} for ${ALLOWED_EMAILS.join(', ') || '(none)'}`);
    console.log(`Login email/password = ${PASSWORD_AUTH_ENABLED ? 'ON for ' + APP_LOGIN_EMAIL : 'OFF'}`);
    console.log(`AUTH_REQUIRED = ${AUTH_REQUIRED}`);
    console.log(`DATA_DIR = ${DATA_DIR}`);
  });
}

module.exports = { buildApp, sendMail, readJson, writeJson };
