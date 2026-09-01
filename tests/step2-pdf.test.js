/**
 * Étape 2 — RED : tests du moteur PDF.
 * Le module pdf-engine.js n'existe pas encore → ces tests doivent FAIL.
 *
 * Logique testée :
 *  - numberToFrenchLetters : conversion chiffres → lettres en français
 *  - buildPdf : génère un PDF non-vide avec les infos du locataire
 *  - filename : nom de fichier slug-friendly
 */
const path = require('path');
const pdfEngine = require('../pdf-engine');

describe('Étape 2 — moteur PDF', () => {
  describe('numberToFrenchLetters', () => {
    test('0 → "ZÉRO EUROS / 0"', () => {
      expect(pdfEngine.numberToFrenchLetters(0)).toBe('ZÉRO EUROS / 0 euros');
    });
    test('1 → "UN EUROS / 1"', () => {
      expect(pdfEngine.numberToFrenchLetters(1)).toBe('UN EUROS / 1 euros');
    });
    test('100 → "CENT EUROS / 100"', () => {
      expect(pdfEngine.numberToFrenchLetters(100)).toBe('CENT EUROS / 100 euros');
    });
    test('950 → "NEUF CENT CINQUANTE EUROS / 950"', () => {
      expect(pdfEngine.numberToFrenchLetters(950)).toBe('NEUF CENT CINQUANTE EUROS / 950 euros');
    });
    test('1000 → "MILLE EUROS / 1000" (cas template original)', () => {
      expect(pdfEngine.numberToFrenchLetters(1000)).toBe('MILLE EUROS / 1000 euros');
    });
    test('1234.56 → chaîne avec virgule décimale', () => {
      const out = pdfEngine.numberToFrenchLetters(1234.56);
      expect(out).toMatch(/MILLE DEUX CENT TRENTE-QUATRE/);
      expect(out).toMatch(/1234[,.]56/);
    });
  });

  describe('slugify (filename)', () => {
    test('"Romain Kretz" → "romain-kretz"', () => {
      expect(pdfEngine.slugify('Romain Kretz')).toBe('romain-kretz');
    });
    test('gère les accents (Étienne → etienne)', () => {
      expect(pdfEngine.slugify('Étienne Dupont')).toBe('etienne-dupont');
    });
  });

  describe('buildPdf', () => {
    const sampleData = {
      proprietaire: 'Roland Ghaoui',
      locataire: 'Romain Kretz',
      adresse: 'Bloc 8, rdc gauche 5-7 AVENUE DE LA MARNE 92120 - Montrouge',
      mois: 'Janvier',
      annee: 2026,
      loyerHC: 950,
      charges: 100,
      total: 1050,
      lieu: 'Bahreïn',
      dateEmission: '10 Janvier 2026',
    };

    test('retourne un Buffer/Uint8Array non-vide', () => {
      const pdf = pdfEngine.buildPdf(sampleData);
      expect(pdf).toBeTruthy();
      const bytes = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
      expect(bytes.length).toBeGreaterThan(500);
    });

    test('le buffer commence par "%PDF-"', () => {
      const pdf = pdfEngine.buildPdf(sampleData);
      const bytes = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
      expect(bytes.slice(0, 5).toString('latin1')).toBe('%PDF-');
    });

    test('contient le nom du propriétaire en clair dans le flux (recherche string)', () => {
      const pdf = pdfEngine.buildPdf(sampleData);
      const bytes = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
      // jsPDF stocke les strings en clair dans le flux, c'est OK pour ce test
      expect(bytes.toString('latin1')).toMatch(/Roland Ghaoui/);
    });

    test('contient le nom du locataire', () => {
      const pdf = pdfEngine.buildPdf(sampleData);
      const bytes = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
      expect(bytes.toString('latin1')).toMatch(/Romain Kretz/);
    });

    test('contient la mention légale article 7-1', () => {
      const pdf = pdfEngine.buildPdf(sampleData);
      const bytes = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
      expect(bytes.toString('latin1')).toMatch(/7-1/);
      expect(bytes.toString('latin1')).toMatch(/89-462/);
    });

    test('contient les valeurs du tableau (950, 100, total)', () => {
      const pdf = pdfEngine.buildPdf(sampleData);
      const bytes = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
      const text = bytes.toString('latin1');
      expect(text).toMatch(/950/);
      expect(text).toMatch(/100/);
      expect(text).toMatch(/1050/);
    });

    test('taille A4 : jsPDF par défaut = "a4" (vérifié via re-parse si possible)', () => {
      const pdf = pdfEngine.buildPdf(sampleData);
      const bytes = Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
      // jsPDF encode la taille dans /MediaBox [0 0 595.28 841.89] (A4 points)
      expect(bytes.toString('latin1')).toMatch(/MediaBox/);
      expect(bytes.toString('latin1')).toMatch(/595/);
      expect(bytes.toString('latin1')).toMatch(/841/);
    });
  });

  describe('buildFilename', () => {
    test('quittance-romain-kretz-2026-01.pdf', () => {
      const fn = pdfEngine.buildFilename({ locataire: 'Romain Kretz', mois: 'Janvier', annee: 2026 });
      expect(fn).toBe('quittance-romain-kretz-2026-01.pdf');
    });
    test('gère accents', () => {
      const fn = pdfEngine.buildFilename({ locataire: 'Étienne Dupont', mois: 'Février', annee: 2026 });
      expect(fn).toBe('quittance-etienne-dupont-2026-02.pdf');
    });
  });
});