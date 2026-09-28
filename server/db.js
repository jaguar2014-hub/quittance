/**
 * SQLite (better-sqlite3) — table users.
 *
 * Stocke les comptes multi-utilisateurs : signup, login (scrypt), forgot/reset.
 * Le reste des données métier reste en JSON (locataires.json, profil.json, …).
 *
 * Schéma users :
 *   id              INTEGER PK auto
 *   email           TEXT UNIQUE NOT NULL (lowercase, trim)
 *   password_hash   TEXT NOT NULL (scrypt N=16384 r=8 p=1 + salt, format "scrypt$N$r$p$saltB64$hashB64")
 *   created_at      TEXT NOT NULL (ISO)
 *   reset_token     TEXT NULL (random hex)
 *   reset_expires   TEXT NULL (ISO)
 *
 * Fonctions exportées :
 *   openDb(dataDir)  : ouvre/initialise la DB (idempotent)
 *   getDb()          : renvoie l'instance (lazy)
 *   seedAdminIfNeeded() : si APP_LOGIN_EMAIL/PASSWORD_HASH ou APP_LOGIN_PASSWORD sont définis,
 *                        crée/met à jour le compte admin
 *
 * Concurrence : better-sqlite3 est synchrone, ce qui simplifie les écritures
 * (pas de race condition). WAL activé pour ne pas bloquer les lectures.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

let _db = null;

function openDb(dataDir) {
  if (_db) return _db;
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'quittances.db');
  _db = new Database(dbPath);
  // Mode DELETE (pas WAL) pour éviter un bug de fermeture sur Node 24 +
  // better-sqlite3 11.x (RemoveEnvironmentCleanupHook assertion failure).
  _db.pragma('journal_mode = DELETE');
  _db.pragma('foreign_keys = ON');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      reset_token TEXT,
      reset_expires TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token);
  `);
  return _db;
}

/**
 * Ferme la DB proprement. Utilisé dans les tests Jest pour éviter un crash natif
 * de better-sqlite3 à la fermeture de l'Isolate (RemoveEnvironmentCleanupHook).
 */
function closeDb() {
  if (_db) {
    try {
      // Force un checkpoint WAL avant fermeture pour éviter les assertions natives
      // au shutdown (Node 24 + better-sqlite3 11.x ont un bug connu).
      try { _db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
      _db.close();
    } catch {}
    _db = null;
  }
}

function getDb() {
  if (!_db) {
    throw new Error('DB non initialisée — appeler openDb(dataDir) au boot du serveur');
  }
  return _db;
}

/**
 * Hash un mot de passe avec scrypt. Stocke tous les params pour pouvoir
 * évoluer plus tard sans casser les anciens hashes.
 * Format : "scrypt$N$r$p$saltB64$hashB64"
 */
function hashPassword(plain) {
  const N = 16384, r = 8, p = 1, keylen = 64;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Vérifie un mot de passe en clair contre un hash scrypt.
 * Retourne true/false. Tolère les anciens hashes SHA-256 hex pour migration douce
 * (utilisé uniquement par verifyLegacySha256 ci-dessous — on ne mélange pas).
 */
function verifyPassword(plain, stored) {
  if (!stored) return false;
  const candidate = String(plain || '');
  if (stored.startsWith('scrypt$')) {
    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    const N = parseInt(parts[1], 10);
    const r = parseInt(parts[2], 10);
    const p = parseInt(parts[3], 10);
    const salt = Buffer.from(parts[4], 'base64');
    const expected = Buffer.from(parts[5], 'base64');
    const got = crypto.scryptSync(candidate, salt, expected.length, { N, r, p });
    return crypto.timingSafeEqual(got, expected);
  }
  // legacy : SHA-256 hex
  if (/^[a-f0-9]{64}$/i.test(stored)) {
    const got = crypto.createHash('sha256').update(candidate).digest('hex');
    return got.toLowerCase() === stored.toLowerCase();
  }
  // legacy : texte clair (ne devrait plus exister après migration)
  return candidate === stored;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

/**
 * Crée ou met à jour un user (utilisé par signup + seedAdmin).
 * Retourne { ok, user, error }.
 */
function createUser({ email, password }) {
  const db = getDb();
  const norm = normalizeEmail(email);
  if (!isValidEmail(norm)) {
    return { ok: false, error: 'Email invalide' };
  }
  if (!password || String(password).length < 8) {
    return { ok: false, error: 'Mot de passe trop court (8 caractères minimum)' };
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(norm);
  if (existing) {
    return { ok: false, error: 'Un compte existe déjà pour cet email' };
  }
  const hash = hashPassword(password);
  const info = db.prepare(
    'INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)'
  ).run(norm, hash, new Date().toISOString());
  return { ok: true, user: { id: info.lastInsertRowid, email: norm } };
}

function findUserByEmail(email) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE email = ?').get(normalizeEmail(email));
}

function findUserById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function updatePassword(userId, newPassword) {
  const db = getDb();
  const hash = hashPassword(newPassword);
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires = NULL WHERE id = ?')
    .run(hash, userId);
}

function setResetToken(email) {
  const db = getDb();
  const user = findUserByEmail(email);
  if (!user) return null; // silencieux (pas de fuite d'info)
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  db.prepare('UPDATE users SET reset_token = ?, reset_expires = ? WHERE id = ?')
    .run(token, expires, user.id);
  return { userId: user.id, email: user.email, token, expires };
}

function consumeResetToken(token) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(String(token || ''));
  if (!row) return null;
  if (!row.reset_expires || new Date(row.reset_expires).getTime() < Date.now()) {
    return null;
  }
  return row;
}

/**
 * Seed admin depuis les variables d'environnement, si définies.
 * Crée le user s'il n'existe pas, met à jour le hash si le mdp change.
 * Idempotent et sûr à appeler à chaque boot.
 */
function seedAdminIfNeeded() {
  const APP_LOGIN_EMAIL = (process.env.APP_LOGIN_EMAIL || '').trim().toLowerCase();
  const APP_LOGIN_PASSWORD = process.env.APP_LOGIN_PASSWORD || '';
  const APP_LOGIN_PASSWORD_HASH = (process.env.APP_LOGIN_PASSWORD_HASH || '').trim().toLowerCase();
  if (!APP_LOGIN_EMAIL) return null;
  const plain = APP_LOGIN_PASSWORD || null;
  if (!plain && !APP_LOGIN_PASSWORD_HASH) return null;
  const db = getDb();
  const existing = findUserByEmail(APP_LOGIN_EMAIL);
  if (!existing) {
    // crée
    const hash = hashPassword(plain || APP_LOGIN_PASSWORD_HASH);
    db.prepare('INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)')
      .run(APP_LOGIN_EMAIL, hash, new Date().toISOString());
    return { email: APP_LOGIN_EMAIL, action: 'created' };
  }
  // met à jour le hash si l'env a changé (utile si on rotate APP_LOGIN_PASSWORD)
  if (plain && !verifyPassword(plain, existing.password_hash)) {
    updatePassword(existing.id, plain);
    return { email: APP_LOGIN_EMAIL, action: 'updated' };
  }
  return { email: APP_LOGIN_EMAIL, action: 'unchanged' };
}

module.exports = {
  openDb,
  closeDb,
  getDb,
  hashPassword,
  verifyPassword,
  normalizeEmail,
  isValidEmail,
  createUser,
  findUserByEmail,
  findUserById,
  updatePassword,
  setResetToken,
  consumeResetToken,
  seedAdminIfNeeded,
};