/**
 * @jest-environment jsdom
 *
 * Étape 4 — RED : tests d'intégration de la section "Nouvelle quittance".
 * Couvre : remplissage du form, aperçu live, génération PDF, modal confirmation, envoi.
 *
 * Stratégie : charger la page complète dans jsdom, mocker fetch et jsPDF,
 * piloter les events, vérifier le résultat.
 */
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.resolve(__dirname, '..', 'quittances-app.html');
const html = fs.readFileSync(HTML_PATH, 'utf8');

/**
 * Set up jsdom with a clean DOM from the HTML file.
 * Mocks window.jspdf, window.fetch.
 */
function setupDom() {
  document.documentElement.innerHTML = html;

  // Mocks des libs externes
  global.window.jspdf = {
    jsPDF: function (opts) {
      this.opts = opts;
      this.text = jest.fn();
      this.setFont = jest.fn();
      this.setFontSize = jest.fn();
      this.line = jest.fn();
      this.setLineWidth = jest.fn();
      this.getTextWidth = jest.fn(() => 50);
      this.splitTextToSize = jest.fn((t) => [t]);
      this.output = jest.fn(() => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]));
      return this;
    },
  };

  // fetch mock : renvoie ok
  global.fetch = jest.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({ ok: true, messageId: 'm1' }), ok: true, status: 200 })
  );

  // Réexécute les <script> inline
  const scripts = document.querySelectorAll('script');
  scripts.forEach(s => {
    if (s.textContent && !s.src) {
      // eslint-disable-next-line no-new-func
      new Function(s.textContent)();
    }
  });
}

describe('Étape 4 — Nouvelle quittance + modal + envoi', () => {
  beforeEach(() => {
    setupDom();
    localStorage.clear();
    setupDom(); // re-render after clear
  });

  test('la page contient un onglet "Nouvelle quittance" qui montre un form', () => {
    const panel = document.getElementById('panel-quittance');
    expect(panel).toBeTruthy();
    expect(panel.innerHTML.toLowerCase()).toMatch(/locataire|mois|loyer/i);
  });

  test('la liste des locataires enregistrés peuple le select de choix', () => {
    // ajoute un locataire
    localStorage.setItem('locataires', JSON.stringify([{
      nom: 'Romain Kretz', email: 'romain@example.com', adresse: 'Bloc 8 92120 Montrouge'
    }]));
    // réinstancie pour relire
    setupDom();

    const select = document.querySelector('#panel-quittance select');
    expect(select).toBeTruthy();
    const options = Array.from(select.querySelectorAll('option')).map(o => o.textContent);
    expect(options.some(t => t.includes('Romain Kretz'))).toBe(true);
  });

  test('formulaire de quittance : champs mois, année, loyer HC, charges', () => {
    const inputs = Array.from(document.querySelectorAll('#panel-quittance input, #panel-quittance select'));
    const names = inputs.map(i => (i.id || i.name || '').toLowerCase());
    expect(names.some(n => n.includes('mois') || n === 'm')).toBe(true);
    expect(names.some(n => n.includes('annee') || n.includes('year'))).toBe(true);
    expect(names.some(n => n.includes('loyer') || n.includes('hc'))).toBe(true);
    expect(names.some(n => n.includes('charges'))).toBe(true);
  });

  test('le total CC = loyer HC + charges, mis à jour à la saisie', () => {
    setupDom(); // réinit avec localStorage vide

    const loyerInput = document.querySelector('#panel-quittance input[id*="loyer" i], #panel-quinture input[id*="hc" i]')
                    || document.getElementById('loyer-hc');
    const chargesInput = document.getElementById('charges');
    const totalField = document.getElementById('total');

    expect(loyerInput).toBeTruthy();
    expect(chargesInput).toBeTruthy();
    expect(totalField).toBeTruthy();

    loyerInput.value = '950';
    loyerInput.dispatchEvent(new Event('input', { bubbles: true }));
    chargesInput.value = '100';
    chargesInput.dispatchEvent(new Event('input', { bubbles: true }));

    expect(totalField.textContent || totalField.value).toMatch(/1050/);
  });

  test('un clic sur "Générer le PDF" ouvre une modal de confirmation', () => {
    localStorage.setItem('locataires', JSON.stringify([{
      nom: 'Romain Kretz', email: 'romain@example.com', adresse: 'Bloc 8 92120 Montrouge'
    }]));
    setupDom(); // réinstancie avec ce locataire

    const setVal = (sel, val) => {
      const el = document.querySelector(sel);
      if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    setVal('#panel-quittance select', '0');
    setVal('#mois', 'Janvier');
    setVal('#annee', '2026');
    setVal('#loyer-hc', '950');
    setVal('#charges', '100');

    const genBtn = Array.from(document.querySelectorAll('#panel-quittance button'))
      .find(b => /générer|generer|generate/i.test(b.textContent));
    expect(genBtn).toBeTruthy();
    genBtn.click();

    const modal = document.querySelector('#confirm-modal, .modal, [role="dialog"]');
    expect(modal).toBeTruthy();
    expect(modal.style.display).not.toBe('none');
    expect(modal.textContent.toLowerCase()).toMatch(/envoyer|confirmer/);
    // Vérifie que le bouton "Envoyer" est dans la modal
    const sendBtn = Array.from(modal.querySelectorAll('button'))
      .find(b => /envoyer|confirmer|oui/i.test(b.textContent));
    expect(sendBtn).toBeTruthy();
  });

  test('Confirmer la modal déclenche fetch POST /api/send avec le PDF en base64', async () => {
    setupDom();
    localStorage.setItem('locataires', JSON.stringify([{
      nom: 'Romain Kretz', email: 'romain@example.com', adresse: 'Bloc 8 92120 Montrouge'
    }]));
    setupDom();

    const setVal = (sel, val) => {
      const el = document.querySelector(sel);
      if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    setVal('#panel-quittance select', '0');
    setVal('#mois', 'Janvier');
    setVal('#annee', '2026');
    setVal('#loyer-hc', '950');
    setVal('#charges', '100');

    const genBtn = Array.from(document.querySelectorAll('#panel-quittance button'))
      .find(b => /générer|generer/i.test(b.textContent));
    genBtn.click();

    // attend microtasks (PDF gén async)
    await new Promise(r => setTimeout(r, 50));

    const confirmBtn = Array.from(document.querySelectorAll('#confirm-modal button, .modal button'))
      .find(b => /envoyer|confirmer|oui/i.test(b.textContent));
    expect(confirmBtn).toBeTruthy();
    confirmBtn.click();

    // attend que fetch soit appelé
    await new Promise(r => setTimeout(r, 50));

    expect(global.fetch).toHaveBeenCalled();
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/api\/send/);
    const body = JSON.parse(opts.body);
    expect(body.to).toBe('romain@example.com');
    expect(body.subject).toMatch(/Janvier/);
    expect(body.subject).toMatch(/2026/);
    expect(body.pdfBase64).toBeTruthy();
    expect(body.filename).toMatch(/quittance-romain-kretz-2026-01\.pdf/);
  });

  test('Annuler la modal ne déclenche pas fetch', async () => {
    setupDom();
    localStorage.setItem('locataires', JSON.stringify([{
      nom: 'Romain Kretz', email: 'romain@example.com', adresse: 'Bloc 8 92120 Montrouge'
    }]));
    setupDom();

    const setVal = (sel, val) => {
      const el = document.querySelector(sel);
      if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
    };
    setVal('#panel-quittance select', '0');
    setVal('#mois', 'Janvier');
    setVal('#annee', '2026');
    setVal('#loyer-hc', '950');
    setVal('#charges', '100');

    const genBtn = Array.from(document.querySelectorAll('#panel-quittance button'))
      .find(b => /générer|generer/i.test(b.textContent));
    genBtn.click();
    await new Promise(r => setTimeout(r, 50));

    const cancelBtn = Array.from(document.querySelectorAll('#confirm-modal button, .modal button'))
      .find(b => /annuler|non|cancel/i.test(b.textContent));
    expect(cancelBtn).toBeTruthy();
    cancelBtn.click();

    await new Promise(r => setTimeout(r, 50));
    expect(global.fetch).not.toHaveBeenCalled();
  });
});