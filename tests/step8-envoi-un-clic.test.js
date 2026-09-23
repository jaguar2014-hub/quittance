/**
 * Étape 8 — Brief C : bouton "Envoyer en un clic" + génération récurrente.
 *
 * Couvre :
 *  - POST /api/paiements/envoyer (mock nodemailer) → ok + sha256 (64 char hex) + filename
 *  - POST /api/paiements/envoyer → met à jour le paiement : quittance_envoyee, dateEnvoiQuittance ISO, pdfSha256
 *  - POST /api/paiements/envoyer avec paiementId inexistant → 404
 *  - POST /api/paiements/envoyer avec locataireId inexistant → 404
 *  - (bonus) POST avec champs manquants → 400
 *
 * Stratégie : on lance le serveur sur un port libre, on isole DATA_DIR via
 * process.env.DATA_DIR vers un répertoire temporaire. nodemailer est mocké
 * pour ne pas tenter de connexion SMTP réelle. On pré-peuple locataires.json
 * et paiements.json via l'API REST (et écriture directe du fichier).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

// Mock nodemailer AVANT require du module serveur (pattern repris de server/tests/send-mail.test.js)
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

const nodemailer = require('nodemailer');

// Isoler la persistance disque avant de charger le module serveur
const TMP_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'quittances-c-'));
process.env.DATA_DIR = TMP_DATA;
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
// Fournir un faux GMAIL_APP_PASSWORD : buildTransport() throw si vide. nodemailer
// lui-même est mocké (jest.mock plus bas), donc createTransport n'est jamais
// contacté réellement.
process.env.GMAIL_APP_PASSWORD = 'fakefakefakefake';
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_ALLOWED_EMAILS;

const { buildApp, readJson } = require('../server/send-mail');

let server, baseUrl;
let mockSendMail;

beforeAll((done) => {
  mockSendMail = jest.fn();
  // buildTransport() instancie createTransport — on le mocke pour qu'il n'échoue pas
  // (le module utilise un mot de passe non vide par défaut si on n'a pas défini GMAIL_APP_PASSWORD,
  //  mais on mocke pour éviter le throw "GMAIL_APP_PASSWORD non défini")
  nodemailer.createTransport = jest.fn(() => ({
    sendMail: mockSendMail,
    verify: jest.fn(cb => cb(null, true)),
  }));
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

beforeEach(() => {
  mockSendMail.mockReset();
  mockSendMail.mockResolvedValue({ messageId: 'msg-test-001', response: '250 OK' });
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

async function seedPaiement({ locataireId, mois = 'Septembre', annee = 2026, total = 1050, statut = 'en_attente' }) {
  const r = await req('POST', '/api/paiements', {
    locataireId, mois, annee, total, statut,
  });
  if (r.status !== 200) throw new Error('seed pmt failed: ' + JSON.stringify(r));
  return r.json.paiement;
}

describe('Étape 8 — Envoi en un clic (Brief C)', () => {

  describe('POST /api/paiements/envoyer (mock nodemailer)', () => {
    test('cas nominal : retourne { ok: true, sha256 (64 hex), filename, messageId }', async () => {
      // Seed un locataire avec email et un paiement en_attente
      fs.writeFileSync(path.join(TMP_DATA, 'locataires.json'), JSON.stringify([
        { id: 'loc_test_001', prenom: 'Romain', nom: 'Dupont', email: 'romain@example.com', adresse: { rue: '12 rue de la Paix', cp: '75002', ville: 'Paris' }, loyerHC: 950, charges: 100 },
      ]));
      const pmt = await seedPaiement({ locataireId: 'loc_test_001' });

      const r = await req('POST', '/api/paiements/envoyer', {
        paiementId: pmt.id,
        locataireId: 'loc_test_001',
      });

      expect(r.status).toBe(200);
      expect(r.json.ok).toBe(true);
      // SHA-256 hex = 64 caractères (256 bits / 4 bits par char)
      expect(typeof r.json.sha256).toBe('string');
      expect(r.json.sha256).toMatch(/^[a-f0-9]{64}$/);
      // Filename retourné, format slug-quittance-AAAA-MM.pdf
      expect(typeof r.json.filename).toBe('string');
      expect(r.json.filename).toMatch(/\.pdf$/);
      // nodemailer.sendMail a été appelé une fois
      expect(mockSendMail).toHaveBeenCalledTimes(1);
      // Le mail contient bien l'email du locataire et le SHA-256 dans les headers
      const mailArgs = mockSendMail.mock.calls[0][0];
      expect(mailArgs.to).toBe('romain@example.com');
      expect(mailArgs.attachments[0].headers['X-PDF-SHA256']).toBe(r.json.sha256);
      expect(mailArgs.subject).toMatch(/Quittance de loyer/);
    });
  });

  describe('POST /api/paiements/envoyer : mise à jour du paiement', () => {
    test('met à jour statut → quittance_envoyee + dateEnvoiQuittance ISO + pdfSha256', async () => {
      fs.writeFileSync(path.join(TMP_DATA, 'locataires.json'), JSON.stringify([
        { id: 'loc_test_002', nom: 'Marie Curie', email: 'marie@example.com', adresse: '16 rue Pierre, 75005 Paris', loyerHC: 800, charges: 50 },
      ]));
      const pmt = await seedPaiement({ locataireId: 'loc_test_002', mois: 'Octobre', annee: 2026, statut: 'en_attente', total: 850 });

      const before = new Date().toISOString();
      const r = await req('POST', '/api/paiements/envoyer', {
        paiementId: pmt.id,
        locataireId: 'loc_test_002',
      });
      const after = new Date().toISOString();

      expect(r.status).toBe(200);
      expect(r.json.ok).toBe(true);
      expect(r.json.paiement.statut).toBe('quittance_envoyee');
      // dateEnvoiQuittance présente, format ISO 8601
      expect(typeof r.json.paiement.dateEnvoiQuittance).toBe('string');
      expect(r.json.paiement.dateEnvoiQuittance).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // Bornes temporelles : entre before et after
      expect(r.json.paiement.dateEnvoiQuittance >= before).toBe(true);
      expect(r.json.paiement.dateEnvoiQuittance <= after).toBe(true);
      // pdfSha256 cohérent
      expect(r.json.paiement.pdfSha256).toBe(r.json.sha256);

      // Persistance disque : relire paiements.json
      const onDisk = readJson('paiements.json', []);
      const found = onDisk.find(p => p.id === pmt.id);
      expect(found).toBeDefined();
      expect(found.statut).toBe('quittance_envoyee');
      expect(found.pdfSha256).toBe(r.json.sha256);
      expect(found.dateEnvoiQuittance).toBe(r.json.paiement.dateEnvoiQuittance);
    });
  });

  describe('POST /api/paiements/envoyer : 404 paiementId inexistant', () => {
    test('renvoie 404 + { ok: false, error } quand paiementId n\'existe pas', async () => {
      fs.writeFileSync(path.join(TMP_DATA, 'locataires.json'), JSON.stringify([
        { id: 'loc_test_003', nom: 'Paul', email: 'paul@example.com', adresse: '1 rue X', loyerHC: 500, charges: 0 },
      ]));

      const r = await req('POST', '/api/paiements/envoyer', {
        paiementId: 'pmt_inexistant_999',
        locataireId: 'loc_test_003',
      });

      expect(r.status).toBe(404);
      expect(r.json.ok).toBe(false);
      expect(r.json.error).toMatch(/Paiement introuvable/);
      // nodemailer ne doit pas avoir été appelé
      expect(mockSendMail).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/paiements/envoyer : 404 locataireId inexistant', () => {
    test('renvoie 404 + { ok: false, error } quand locataireId n\'existe pas', async () => {
      // Seed un paiement valide (mais pour un locataire qu'on ne créera pas)
      fs.writeFileSync(path.join(TMP_DATA, 'locataires.json'), JSON.stringify([
        { id: 'loc_test_004', nom: 'Sophie', email: 'sophie@example.com', adresse: '5 rue Y', loyerHC: 600, charges: 0 },
      ]));
      const pmt = await seedPaiement({ locataireId: 'loc_test_004' });

      const r = await req('POST', '/api/paiements/envoyer', {
        paiementId: pmt.id,
        locataireId: 'loc_inexistant_888',
      });

      expect(r.status).toBe(404);
      expect(r.json.ok).toBe(false);
      expect(r.json.error).toMatch(/Locataire introuvable/);
      expect(mockSendMail).not.toHaveBeenCalled();

      // Le paiement ne doit PAS avoir été modifié (statut reste en_attente)
      const onDisk = readJson('paiements.json', []);
      const found = onDisk.find(p => p.id === pmt.id);
      expect(found.statut).toBe('en_attente');
      expect(found.pdfSha256).toBeUndefined();
    });
  });

  describe('POST /api/paiements/envoyer : 400 champs manquants', () => {
    test('renvoie 400 si paiementId ou locataireId manquant', async () => {
      const r1 = await req('POST', '/api/paiements/envoyer', { paiementId: 'x' });
      expect(r1.status).toBe(400);
      expect(r1.json.ok).toBe(false);

      const r2 = await req('POST', '/api/paiements/envoyer', { locataireId: 'y' });
      expect(r2.status).toBe(400);
      expect(r2.json.ok).toBe(false);
    });
  });
});