/**
 * @jest-environment jsdom
 *
 * Étape 1 — RED : on veut que la page HTML charge, affiche les onglets,
 * et que l'ajout d'un locataire apparaisse dans la liste.
 * Le fichier HTML n'existe pas encore → ce test va FAIL (cannot load).
 */
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.resolve(__dirname, '..', 'quittances-app.html');

describe('Étape 1 — squelette HTML + form locataire', () => {
  test('le fichier quittances-app.html existe', () => {
    expect(fs.existsSync(HTML_PATH)).toBe(true);
  });

  test('la page charge avec un onglet "Locataires" et un onglet "Quittance"', () => {
    document.documentElement.innerHTML = fs.readFileSync(HTML_PATH, 'utf8');
    // Déclenche les <script> inline (window.onload listeners, etc.)
    const scripts = document.querySelectorAll('script');
    scripts.forEach(s => {
      if (s.textContent && !s.src) {
        // eslint-disable-next-line no-new-func
        new Function(s.textContent)();
      }
    });

    const tabs = Array.from(document.querySelectorAll('[data-tab], .tab, button, a'))
      .map(el => el.textContent.trim().toLowerCase());
    expect(tabs.some(t => t.includes('locataire'))).toBe(true);
    expect(tabs.some(t => t.includes('quittance'))).toBe(true);
  });

  test('le formulaire locataire contient les champs nom, email, adresse', () => {
    document.documentElement.innerHTML = fs.readFileSync(HTML_PATH, 'utf8');
    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    const names = inputs.map(i => (i.name || i.id || i.placeholder || '').toLowerCase());
    expect(names.some(n => n.includes('nom'))).toBe(true);
    expect(names.some(n => n.includes('email') || n.includes('mail'))).toBe(true);
    expect(names.some(n => n.includes('adresse') || n.includes('address'))).toBe(true);
  });

  test('ajouter un locataire le fait apparaître dans la liste après save', () => {
    // Reset storage
    localStorage.clear();
    document.documentElement.innerHTML = fs.readFileSync(HTML_PATH, 'utf8');
    const scripts = document.querySelectorAll('script');
    scripts.forEach(s => {
      if (s.textContent && !s.src) {
        // eslint-disable-next-line no-new-func
        new Function(s.textContent)();
      }
    });

    // Remplir le form (essaye plusieurs heuristiques de sélecteur)
    const setVal = (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const nameInput = document.querySelector('input[name*="nom" i], input[id*="nom" i], input[placeholder*="nom" i]');
    const emailInput = document.querySelector('input[name*="email" i], input[type="email"], input[id*="email" i]');
    const addrInput = document.querySelector('input[name*="adresse" i], textarea[name*="adresse" i], input[id*="adresse" i], textarea[id*="adresse" i]');

    expect(nameInput).toBeTruthy();
    expect(emailInput).toBeTruthy();
    expect(addrInput).toBeTruthy();

    nameInput.value = 'Romain Kretz';
    emailInput.value = 'romain@example.com';
    addrInput.value = 'Bloc 8 rdc gauche 92120 Montrouge';
    [nameInput, emailInput, addrInput].forEach(el =>
      el.dispatchEvent(new Event('input', { bubbles: true }))
    );

    // Trouver le bouton "ajouter" ou "enregistrer"
    const saveBtn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
      .find(b => /ajouter|enregistrer|save|ajout/i.test(b.textContent + ' ' + (b.value || '')));
    expect(saveBtn).toBeTruthy();
    saveBtn.click();

    // Le locataire doit apparaître dans la liste
    const body = document.body.textContent;
    expect(body).toMatch(/Romain Kretz/);

    // Et être persisté
    const stored = JSON.parse(localStorage.getItem('locataires') || localStorage.getItem('tenants') || '[]');
    expect(Array.isArray(stored)).toBe(true);
    expect(stored.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(stored)).toMatch(/Romain Kretz/);
  });
});