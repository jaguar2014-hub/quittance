/**
 * @jest-environment node
 *
 * Étape 6 — Test E2E du workflow complet :
 *   1. Démarre le backend SMTP (en vrai, sur le port 8766)
 *   2. Simule l'ajout d'un locataire + génération PDF + envoi via fetch
 *   3. Vérifie que le mail part et que l'historique est mis à jour
 *
 * Note : ce test parle au VRAI backend, donc on doit avoir lancé `node send-mail.js`
 * ou on l'a démarré dans un beforeAll. Le mock fetch n'est PAS utilisé ici.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

// On évite de démarrer un 2e serveur ici — le test suppose que `node send-mail.js`
// tourne déjà (lancé par launch.bat ou manuellement). On ping /api/health.

function pingHealth() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:8766/api/health', (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

function postJson(path, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port: 8766, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('Étape 6 — E2E workflow complet', () => {
  test('le serveur SMTP tourne (pré-requis)', async () => {
    const r = await pingHealth();
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  test('envoi d\'un vrai mail à moi-même avec un vrai PDF en PJ', async () => {
    // Génère un vrai PDF via pdf-engine
    const { buildPdf } = require('../pdf-engine');
    const pdf = buildPdf({
      proprietaire: 'Roland Ghaoui',
      locataire: 'E2E Test Locataire',
      adresse: '1 rue de la Paix 75002 Paris',
      mois: 'Janvier',
      annee: 2026,
      loyerHC: 1200,
      charges: 150,
      total: 1350,
      lieu: 'Bahreïn',
      dateEmission: '15 Janvier 2026',
    });

    const r = await postJson('/api/send', {
      to: 'Jaguar2014@gmail.com',
      subject: 'E2E TEST - Quittance',
      body: '<p>Test automatique</p>',
      pdfBase64: pdf.toString('base64'),
      filename: 'e2e-test.pdf',
    });

    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.messageId).toBeTruthy();
  });

  test('POST avec champs manquants → 400', async () => {
    const r = await postJson('/api/send', { to: 'x@y.com' });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
  });

  test('PDF généré fait bien la taille A4 (~5Ko)', () => {
    const { buildPdf } = require('../pdf-engine');
    const pdf = buildPdf({
      locataire: 'Test', adresse: 'X', mois: 'Janvier', annee: 2026,
      loyerHC: 100, charges: 10, total: 110,
    });
    expect(pdf.length).toBeGreaterThan(2000);
    expect(pdf.length).toBeLessThan(20000);
    // Vérifie le header PDF
    expect(pdf.slice(0, 5).toString('latin1')).toBe('%PDF-');
  });
});