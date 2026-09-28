/**
 * Tests auth multi-comptes : signup, login DB, forgot/reset, change-password.
 *
 * Stratégie : on lance le serveur Express directement dans le process Jest
 * (via buildApp + listen), pas dans un subprocess. Ça évite les SIGKILL/SIGTERM
 * qui font planter better-sqlite3 au shutdown.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

// On capture l'env AVANT de require le serveur (le serveur fige certaines vars au load)
const TMP_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'quittances-auth-'));
process.env.DATA_DIR = TMP_DATA;
process.env.NODE_ENV = 'test';
process.env.HOST = '127.0.0.1';
// On évite que le seed APP_LOGIN_EMAIL ne pollue nos tests
delete process.env.APP_LOGIN_EMAIL;
delete process.env.APP_LOGIN_PASSWORD;
delete process.env.APP_LOGIN_PASSWORD_HASH;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_ALLOWED_EMAILS;
delete process.env.GMAIL_APP_PASSWORD;

// Charge le serveur (better-sqlite3 ouvre la DB, app.js est créé)
const { buildApp } = require('../server/send-mail');

let server, baseUrl;

beforeAll((done) => {
  // Reset du module DB pour forcer une ré-init propre (better-sqlite3 garde l'instance)
  delete require.cache[require.resolve('../server/db')];
  delete require.cache[require.resolve('../server/send-mail')];
  // Recharger les variables figées
  process.env.DATA_DIR = TMP_DATA;
  process.env.HOST = '127.0.0.1';
  delete process.env.APP_LOGIN_EMAIL;
  delete process.env.APP_LOGIN_PASSWORD;
  delete process.env.APP_LOGIN_PASSWORD_HASH;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.GOOGLE_ALLOWED_EMAILS;
  delete process.env.GMAIL_APP_PASSWORD;

  const { buildApp } = require('../server/send-mail');
  const app = buildApp();
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll(async () => {
  // Ferme le serveur puis attend un peu (laisses Express + fetch agents finir)
  if (server) await new Promise((res) => server.close(res));
  await new Promise((res) => setTimeout(res, 200));
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch {}
});

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (opts.cookie) headers.Cookie = opts.cookie;
    const r = http.request(`${baseUrl}${urlPath}`, { method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(buf || '{}') }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, json: {} }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function readDb(email) {
  const dbPath = path.join(TMP_DATA, 'quittances.db');
  if (!fs.existsSync(dbPath)) return null;
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  db.close();
  return row;
}

describe('Auth multi-comptes — signup', () => {
  test('POST /auth/signup avec email + mdp valide → 200 + cookie', async () => {
    const r = await req('POST', '/auth/signup', { email: 'alice@example.com', password: 'motdepasse1' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.email).toBe('alice@example.com');
    expect(r.headers['set-cookie']).toBeDefined();
  });

  test('POST /auth/signup avec email déjà existant → 400', async () => {
    const r = await req('POST', '/auth/signup', { email: 'alice@example.com', password: 'motdepasse2' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/existe/i);
  });

  test('POST /auth/signup avec email invalide → 400', async () => {
    const r = await req('POST', '/auth/signup', { email: 'pas-un-email', password: 'motdepasse1' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/email/i);
  });

  test('POST /auth/signup avec mdp trop court → 400', async () => {
    const r = await req('POST', '/auth/signup', { email: 'bob@example.com', password: 'court' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/trop court/i);
  });
});

describe('Auth multi-comptes — login DB', () => {
  let cookie;

  test('POST /auth/login avec bons creds DB → 200 + cookie', async () => {
    await req('POST', '/auth/signup', { email: 'login-user@example.com', password: 'mon-mdp-12' });
    const r = await req('POST', '/auth/login', { email: 'login-user@example.com', password: 'mon-mdp-12' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.email).toBe('login-user@example.com');
    cookie = r.headers['set-cookie'][0].split(';')[0];
  });

  test('POST /auth/login avec mauvais mdp → 401', async () => {
    const r = await req('POST', '/auth/login', { email: 'login-user@example.com', password: 'wrong' });
    expect(r.status).toBe(401);
  });

  test('POST /auth/login avec email inexistant → 401', async () => {
    const r = await req('POST', '/auth/login', { email: 'ghost@example.com', password: 'whatever' });
    expect(r.status).toBe(401);
  });

  test('GET /api/me avec cookie → authenticated=true', async () => {
    const r = await req('GET', '/api/me', null, { cookie });
    expect(r.status).toBe(200);
    expect(r.json.authenticated).toBe(true);
    expect(r.json.email).toBe('login-user@example.com');
    expect(r.json.loginEnabled).toBe(true);
  });
});

describe('Auth multi-comptes — forgot/reset', () => {
  beforeAll(async () => {
    await req('POST', '/auth/signup', { email: 'reset-me@example.com', password: 'avant-reset' });
  });

  test('POST /auth/forgot pour email inconnu → ok:true silencieux', async () => {
    const r = await req('POST', '/auth/forgot', { email: 'ghost-2@example.com' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
  });

  test('POST /auth/forgot pour email existant → ok:true + token créé en DB', async () => {
    const r = await req('POST', '/auth/forgot', { email: 'reset-me@example.com' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    const dbRow = readDb('reset-me@example.com');
    expect(dbRow).toBeTruthy();
    expect(dbRow.reset_token).toBeTruthy();
    expect(dbRow.reset_token.length).toBe(48);
  });

  test('POST /auth/reset avec token valide → change le mdp', async () => {
    const before = readDb('reset-me@example.com');
    const r = await req('POST', '/auth/reset', { token: before.reset_token, newPassword: 'apres-reset' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);

    const login = await req('POST', '/auth/login', { email: 'reset-me@example.com', password: 'apres-reset' });
    expect(login.status).toBe(200);

    const after = readDb('reset-me@example.com');
    expect(after.reset_token).toBeNull();
    expect(after.reset_expires).toBeNull();
  });

  test('POST /auth/reset avec token invalide → 400', async () => {
    const r = await req('POST', '/auth/reset', { token: 'inexistant', newPassword: 'nouveau-mdp' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/invalide|expir/i);
  });

  test('POST /auth/reset avec mdp trop court → 400', async () => {
    await req('POST', '/auth/forgot', { email: 'reset-me@example.com' });
    const row = readDb('reset-me@example.com');
    const r = await req('POST', '/auth/reset', { token: row.reset_token, newPassword: 'x' });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/trop court/i);
  });
});

describe('Auth multi-comptes — change-password', () => {
  let cookie;

  beforeAll(async () => {
    const r = await req('POST', '/auth/signup', { email: 'change@example.com', password: 'old-password' });
    cookie = r.headers['set-cookie'][0].split(';')[0];
  });

  test('POST /auth/change-password sans auth → 401', async () => {
    const r = await req('POST', '/auth/change-password', { currentPassword: 'old-password', newPassword: 'new-password' });
    expect(r.status).toBe(401);
  });

  test('POST /auth/change-password avec mauvais currentPassword → 401', async () => {
    const r = await req('POST', '/auth/change-password', { currentPassword: 'wrong', newPassword: 'new-password' }, { cookie });
    expect(r.status).toBe(401);
  });

  test('POST /auth/change-password OK → 200 + login fonctionne avec nouveau mdp', async () => {
    const r = await req('POST', '/auth/change-password', { currentPassword: 'old-password', newPassword: 'new-password' }, { cookie });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);

    const login = await req('POST', '/auth/login', { email: 'change@example.com', password: 'new-password' });
    expect(login.status).toBe(200);
  });
});

describe('Auth multi-comptes — health endpoint', () => {
  test('GET /api/health → signupEnabled=true', async () => {
    const r = await req('GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.signupEnabled).toBe(true);
    expect(r.json.loginConfigured).toBe(true);
  });
});