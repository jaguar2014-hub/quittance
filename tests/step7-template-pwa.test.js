/**
 * Étape 7 — Brief B : éditeur template + PWA installable + suivi paiements.
 *
 * Couvre :
 *  - GET  /api/template            → renvoie les valeurs par défaut si pas de fichier
 *  - POST /api/template            → persiste les valeurs
 *  - GET  /manifest.webmanifest    → 200 + JSON valide avec name/short_name/icons
 *  - GET  /sw.js                   → 200 + commence par "// service worker" (ou contient addEventListener)
 *  - POST /api/paiements           → crée un paiement (statut valide)
 *  - GET  /api/paiements/:id       → renvoie la liste filtrée
 *  - POST /api/paiements avec statut invalide → 400
 *
 * Stratégie : on lance le serveur sur un port libre, on isole DATA_DIR via
 * une variable d'environnement pour ne pas toucher le data/ de l'utilisateur.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

// Isoler la persistance disque avant de charger le module serveur
const TMP_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'quittances-b-'));
process.env.DATA_DIR = TMP_DATA;
// Forcer le port à 0 pour laisser l'OS choisir un port libre
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
// Désactiver OAuth pour éviter toute dépendance externe
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_ALLOWED_EMAILS;
delete process.env.GMAIL_APP_PASSWORD;

const { buildApp } = require('../server/send-mail');

let server, baseUrl;

beforeAll((done) => {
  const app = buildApp();
  server = app.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => {
    try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch {}
    done();
  });
});

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(p, baseUrl);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Accept': 'application/json' },
    };
    if (data) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

describe('Étape 7 — Template + PWA + Paiements (Brief B)', () => {

  describe('GET /api/template (défaut si pas de fichier)', () => {
    test('renvoie 200 + valeurs par défaut complètes quand data/template.json absent', async () => {
      const r = await req('GET', '/api/template');
      expect(r.status).toBe(200);
      expect(r.json).toBeTruthy();
      // Le serveur renvoie toujours les défauts si le fichier n'existe pas
      expect(r.json.proprietaire).toBeDefined();
      expect(r.json.proprietaire.nom).toBe('Roland Ghaoui');
      expect(typeof r.json.mentionLegale).toBe('string');
      expect(r.json.mentionLegale).toMatch(/loi n° 89-462/);
      expect(r.json.lieuDefaut).toBe('Bahreïn');
      expect(r.json.signatureLabel).toBe('Le bailleur');
      expect(r.json.signatureLoiElan).toBe(true);
      expect(r.json.logoUrl).toBeNull();
    });
  });

  describe('POST /api/template (persistance)', () => {
    test('renvoie 200 + persiste les nouvelles valeurs', async () => {
      const payload = {
        proprietaire: {
          nom: 'Test Bailleur',
          email: 'bailleur@test.com',
          adresse: '75001 Paris',
          telephone: '+33 6 11 22 33 44',
        },
        mentionLegale: 'Mention personnalisée test',
        lieuDefaut: 'Paris',
        signatureLabel: 'Le propriétaire',
        signatureLoiElan: false,
        logoUrl: 'https://example.com/logo.png',
      };
      const r = await req('POST', '/api/template', payload);
      expect(r.status).toBe(200);
      expect(r.json.ok).toBe(true);
      expect(r.json.template.proprietaire.nom).toBe('Test Bailleur');
      expect(r.json.template.lieuDefaut).toBe('Paris');
      expect(r.json.template.signatureLoiElan).toBe(false);

      // Vérif lecture ensuite
      const r2 = await req('GET', '/api/template');
      expect(r2.json.proprietaire.nom).toBe('Test Bailleur');
      expect(r2.json.lieuDefaut).toBe('Paris');

      // Le fichier a bien été créé sur disque
      const fp = path.join(TMP_DATA, 'template.json');
      expect(fs.existsSync(fp)).toBe(true);
      const onDisk = JSON.parse(fs.readFileSync(fp, 'utf8'));
      expect(onDisk.proprietaire.nom).toBe('Test Bailleur');
    });
  });

  describe('GET /manifest.webmanifest (PWA)', () => {
    test('renvoie 200 + JSON valide avec name/short_name/icons', async () => {
      const r = await req('GET', '/manifest.webmanifest');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/application\/json|json/);
      const j = JSON.parse(r.text);
      expect(j.name).toBe('Quittances de Loyer');
      expect(j.short_name).toBe('Quittances');
      expect(j.start_url).toBe('/');
      expect(j.scope).toBe('/');
      expect(j.display).toBe('standalone');
      expect(j.theme_color).toBe('#2c5aa0');
      expect(Array.isArray(j.icons)).toBe(true);
      expect(j.icons.length).toBeGreaterThanOrEqual(2);
      // Au moins un 192x192 et un 512x512
      const sizes = j.icons.map(i => i.sizes);
      expect(sizes).toContain('192x192');
      expect(sizes).toContain('512x512');
    });
  });

  describe('GET /sw.js (service worker)', () => {
    test('renvoie 200 + contenu JavaScript valide', async () => {
      const r = await req('GET', '/sw.js');
      expect(r.status).toBe(200);
      // Le Content-Type doit être du JS (express.static le sert correctement)
      expect(r.headers['content-type']).toMatch(/javascript|text/);
      // Critère du brief : commence par "// service worker" OU contient addEventListener
      const ok = r.text.trimStart().startsWith('// service worker') || /addEventListener/.test(r.text);
      expect(ok).toBe(true);
      // Doit référencer notre cache v2
      expect(r.text).toMatch(/quittances-v2/);
      // Doit au moins un des URLs pré-cachées
      expect(r.text).toMatch(/\/manifest\.webmanifest|\/quittances-app\.html|\//);
    });
  });

  describe('POST /api/paiements (création)', () => {
    test('crée un paiement et le récupère via GET /:locataireId', async () => {
      const pmt = {
        locataireId: 'loc_2026_test',
        mois: 'Septembre',
        annee: 2026,
        total: 1050,
        statut: 'paye',
        datePaiement: '2026-09-01',
      };
      const r = await req('POST', '/api/paiements', pmt);
      expect(r.status).toBe(200);
      expect(r.json.ok).toBe(true);
      expect(r.json.paiement.id).toMatch(/^pmt_2026_septembre_/);
      expect(r.json.paiement.statut).toBe('paye');

      // GET filtré
      const r2 = await req('GET', '/api/paiements/loc_2026_test');
      expect(r2.status).toBe(200);
      expect(Array.isArray(r2.json)).toBe(true);
      expect(r2.json.length).toBe(1);
      expect(r2.json[0].mois).toBe('Septembre');

      // GET pour un autre id → liste vide
      const r3 = await req('GET', '/api/paiements/loc_autre');
      expect(r3.json.length).toBe(0);
    });

    test('rejette (400) si statut invalide', async () => {
      const r = await req('POST', '/api/paiements', {
        locataireId: 'loc_x', mois: 'Janvier', annee: 2026, statut: 'inconnu',
      });
      expect(r.status).toBe(400);
      expect(r.json.ok).toBe(false);
      expect(r.json.error).toMatch(/statut/);
    });

    test('rejette (400) si champs requis manquants', async () => {
      const r = await req('POST', '/api/paiements', { statut: 'paye' });
      expect(r.status).toBe(400);
      expect(r.json.ok).toBe(false);
    });
  });
});
