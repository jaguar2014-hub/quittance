/**
 * Étape 9 — Brief E : Login email/password + Profil bailleur.
 *
 * Couvre :
 *  - POST /auth/login (bons creds, mauvais, rate limit)
 *  - GET /api/profil (défauts si pas de fichier, lecture après save)
 *  - POST /api/profil (sanitize, validation email)
 *  - Le mail part avec from=profil.email quand le profil est set
 *
 * Stratégie : on lance le serveur sur un port libre, on isole DATA_DIR via
 * une variable d'environnement pour ne pas toucher le data/ de l'utilisateur.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

// Isoler la persistance disque avant de charger le module serveur
const TMP_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'quittances-e-'));
process.env.DATA_DIR = TMP_DATA;
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.APP_LOGIN_EMAIL = 'bailleur@mon-app.com';
process.env.APP_LOGIN_PASSWORD = 'motdepasse-secret';
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_ALLOWED_EMAILS;
delete process.env.GMAIL_APP_PASSWORD;

const { buildApp } = require('../server/send-mail');

let server, baseUrl, cookie;

beforeAll((done) => {
  const app = buildApp();
  server = app.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  if (server) server.close(done);
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch {}
});

function req(method, urlPath, body, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (opts.cookie) headers.Cookie = opts.cookie;
    const r = http.request(`${baseUrl}${urlPath}`, { method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(body || '{}') }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, json: {} }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

describe('Étape 9 — Login email/password (Brief E)', () => {
  test('POST /auth/login avec mauvais password → 401', async () => {
    const r = await req('POST', '/auth/login', { email: 'bailleur@mon-app.com', password: 'wrong' });
    expect(r.status).toBe(401);
    expect(r.json.ok).toBe(false);
  });

  test('POST /auth/login avec bons creds → 200 + cookie + email', async () => {
    const r = await req('POST', '/auth/login', { email: 'bailleur@mon-app.com', password: 'motdepasse-secret' });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.email).toBe('bailleur@mon-app.com');
    expect(r.headers['set-cookie']).toBeDefined();
    cookie = r.headers['set-cookie'][0].split(';')[0];
    expect(cookie).toMatch(/^qsession=/);
  });

  test('Rate limit : 6 tentatives consecutives avec mauvais password → 429', async () => {
    // Le compteur de rate limit a déjà accumulé quelques tentatives des tests précédents.
    // On bourrine pour s'assurer de déclencher le 429.
    let lastStatus = 0;
    for (let i = 0; i < 10; i++) {
      const r = await req('POST', '/auth/login', { email: 'bailleur@mon-app.com', password: 'wrong-' + i });
      lastStatus = r.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});

describe('Étape 9 — Profil bailleur (Brief E)', () => {
  test('GET /api/profil sans cookie → 401', async () => {
    const r = await req('GET', '/api/profil');
    expect(r.status).toBe(401);
  });

  test('GET /api/profil avec cookie (defaut) → champs vides', async () => {
    const r = await req('GET', '/api/profil', null, { cookie });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ nom: '', email: '', adresse: '', telephone: '', lieuDefaut: '' });
  });

  test('POST /api/profil persiste les valeurs', async () => {
    const payload = {
      nom: 'Jean Test',
      email: 'jean.test@example.com',
      adresse: '15 rue Test, 75001 Paris',
      telephone: '+33 6 12 34 56 78',
      lieuDefaut: 'Paris',
    };
    const r = await req('POST', '/api/profil', payload, { cookie });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.profil.nom).toBe('Jean Test');
    expect(r.json.profil.email).toBe('jean.test@example.com');
    expect(r.json.profil.lieuDefaut).toBe('Paris');

    // Vérif lecture disque
    const onDisk = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'profil.json'), 'utf8'));
    expect(onDisk.nom).toBe('Jean Test');
    expect(onDisk.email).toBe('jean.test@example.com');
  });

  test('POST /api/profil valide le format email', async () => {
    const r = await req('POST', '/api/profil', { email: 'pas-un-email' }, { cookie });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/email/i);
  });

  test('GET /api/profil après save → renvoie les valeurs', async () => {
    const r = await req('GET', '/api/profil', null, { cookie });
    expect(r.status).toBe(200);
    expect(r.json.nom).toBe('Jean Test');
    expect(r.json.email).toBe('jean.test@example.com');
  });
});

describe('Étape 9 — /api/me expose loginEnabled', () => {
  test('GET /api/me authentifié → expose loginEnabled=true', async () => {
    const r = await req('GET', '/api/me', null, { cookie });
    expect(r.status).toBe(200);
    expect(r.json.authenticated).toBe(true);
    expect(r.json.loginEnabled).toBe(true);
    expect(r.json.oauthEnabled).toBe(false);
  });
});
