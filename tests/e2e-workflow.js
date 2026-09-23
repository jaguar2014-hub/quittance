#!/usr/bin/env node
/**
 * Test E2E standalone du workflow complet "Envoyer en un clic".
 *
 * - Démarre un faux serveur SMTP (smtpd.DebuggingServer sur 127.0.0.1:2525)
 *   qui capture TOUT ce qui est envoyé dans /tmp/captured_emails/
 * - Monkey-patch nodemailer pour utiliser ce faux serveur
 * - Démarre le serveur quittances-app sur port 3906 (DATA_DIR isolé)
 * - Désactive authMiddleware pour les tests
 * - Scénario :
 *   1. Crée un locataire Brief A complet
 *   2. Crée un paiement en_attente
 *   3. POST /api/paiements/envoyer
 *   4. Vérifie :
 *     - Réponse 200 {ok, sha256, filename}
 *     - Fichier .eml capturé contient le PDF en PJ
 *     - Paiement passé à quittance_envoyee avec pdfSha256
 *     - Le SHA-256 du PDF capturé = SHA-256 retourné
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

// ============ Setup ============
const TMP_DATA = fs.mkdtempSync(path.join(require('os').tmpdir(), 'q-e2e-'));
const TMP_EMAILS = fs.mkdtempSync(path.join(require('os').tmpdir(), 'q-emails-'));
process.chdir('C:/Users/rolan/quittances-app');
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = TMP_DATA;
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '2525';
process.env.SMTP_USER = 'fake-bailleur@example.com';
process.env.GMAIL_APP_PASSWORD = 'fake-app-password-16chars';
process.env.SMTP_SECURE = 'false';   // Faux SMTP local ne supporte pas SSL
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_ALLOWED_EMAILS;

// ============ Faux serveur SMTP (capture binaire) ============
let capturedEmails = [];
function startFakeSmtp() {
  return new Promise((resolve) => {
    const server = net.createServer((conn) => {
      let buf = Buffer.alloc(0);
      let state = 'greeting';
      conn.write('220 q-e2e-fake-smtp ready\r\n');

      conn.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        let idx;
        while ((idx = buf.indexOf('\r\n')) !== -1) {
          const line = buf.slice(0, idx).toString('utf-8');
          buf = buf.slice(idx + 2);
          handle(line);
        }
      });

      function handle(line) {
        if (line.startsWith('EHLO') || line.startsWith('HELO')) {
          conn.write('250-q-e2e-fake-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        } else if (line.startsWith('AUTH')) {
          conn.write('235 OK\r\n');
        } else if (line.startsWith('MAIL FROM')) {
          conn.write('250 OK\r\n');
        } else if (line.startsWith('RCPT TO')) {
          conn.write('250 OK\r\n');
        } else if (line === 'DATA') {
          conn.write('354 Send data, end with <CR><LF>.<CR><LF>\r\n');
          state = 'data';
        } else if (state === 'data') {
          if (line === '.') {
            // fin
            const emlPath = path.join(TMP_EMAILS, `email_${capturedEmails.length + 1}.eml`);
            fs.writeFileSync(emlPath, currentData);
            capturedEmails.push(emlPath);
            conn.write('250 OK\r\n');
            state = 'greeting';
            currentData = null;
          } else {
            // En mode data, les lignes commençant par . sont décodées (unstuffed)
            const unstuffed = line.startsWith('.') ? line.slice(1) : line;
            if (currentData === null) currentData = '';
            currentData += unstuffed + '\r\n';
          }
        } else if (line === 'QUIT') {
          conn.write('221 Bye\r\n');
          conn.end();
        } else if (line === 'RSET') {
          conn.write('250 OK\r\n');
        } else if (line === 'NOOP') {
          conn.write('250 OK\r\n');
        } else if (state === 'greeting') {
          // catch-all
          conn.write('250 OK\r\n');
        }
      }

      let currentData = null;
      conn.on('error', () => {});
    });

    server.listen(2525, '127.0.0.1', () => resolve(server));
  });
}

// ============ Patch send-mail.js : bypass authMiddleware ============
function patchSendMail() {
  const ROOT = path.join(__dirname, '..');
  const smPath = path.join(ROOT, 'server/send-mail.js');
  const code = fs.readFileSync(smPath, 'utf-8');
  // Trouve la fonction authMiddleware en comptant les accolades (greedy match balanced)
  const startIdx = code.indexOf('function authMiddleware');
  if (startIdx === -1) throw new Error('authMiddleware introuvable');
  let depth = 0;
  let endIdx = -1;
  let foundStart = false;
  for (let i = startIdx; i < code.length; i++) {
    if (code[i] === '{') { depth++; foundStart = true; }
    else if (code[i] === '}') { depth--; if (foundStart && depth === 0) { endIdx = i; break; } }
  }
  if (endIdx === -1) throw new Error('fin de authMiddleware introuvable');
  const before = code.substring(0, startIdx);
  const after = code.substring(endIdx + 1);
  // Patch 2 : buildTransport utilise secure=false quand SMTP_SECURE=false
  let patched = before + 'function authMiddleware(req, res, next) { next(); }' + after;
  if (process.env.SMTP_SECURE === 'false') {
    patched = patched.replace(
      /secure:\s*true/,
      'secure: false, requireTLS: false, ignoreTLS: true'
    );
  }
  console.log('       [patchSendMail] SMTP_SECURE=' + process.env.SMTP_SECURE + ', patched secure=' + (process.env.SMTP_SECURE === 'false' ? 'false' : 'true (default)'));
  const patchedPath = path.join(ROOT, 'server/_sm_patched.js');
  fs.writeFileSync(patchedPath, patched);
  return require(patchedPath);
}

// ============ HTTP helpers ============
function makeReq(port) {
  return (method, urlPath, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1', port, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body || '{}') }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ============ MAIN ============
(async () => {
  console.log('=== E2E workflow "Envoyer en un clic" ===\n');

  // 1. Démarre faux SMTP
  console.log('[1/6] Démarrage faux SMTP sur 127.0.0.1:2525...');
  const smtpServer = await startFakeSmtp();
  console.log('       SMTP prêt\n');

  // 2. Charge send-mail.js avec authMiddleware bypassed
  console.log('[2/6] Chargement send-mail.js (authMiddleware bypassed)...');
  const { buildApp } = patchSendMail();
  console.log('       Module chargé\n');

  // 3. Démarre serveur sur port libre
  console.log('[3/6] Démarrage serveur sur port libre...');
  const app = buildApp();
  const server = await new Promise((res, rej) => {
    const s = app.listen(0, '127.0.0.1', () => res(s));
    s.on('error', rej);
  });
  const port = server.address().port;
  const req = makeReq(port);
  console.log(`       Serveur prêt sur port ${port}\n`);

  let allOK = true;
  function check(name, cond, details) {
    const status = cond ? 'OK ' : 'KO ';
    console.log(`       ${status}${name}${details ? ' — ' + details : ''}`);
    if (!cond) allOK = false;
  }

  try {
    // 4. Crée un locataire Brief A complet
    console.log('[4/6] POST /api/locataires (Brief A complet)...');
    const r1 = await req('POST', '/api/locataires', {
      prenom: 'Pierre',
      nom: 'Curie',
      email: 'pierre.curie@example.com',
      adresse: { rue: '24 rue Pierre', complement: 'Étage 2', cp: '75005', ville: 'Paris' },
      loyerHC: 1200,
      charges: 150,
      dateEntree: '2024-01-15',
      bailRef: 'B-CURIE-2024-01'
    });
    check('HTTP 200', r1.status === 200, `status=${r1.status}`);
    check('ok=true', r1.body.ok === true);
    check('id retourné', !!r1.body.id && /^loc_/.test(r1.body.id), `id=${r1.body.id}`);
    const locataireId = r1.body.id;
    const saved = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'locataires.json'), 'utf-8'));
    const loc = saved[0];
    check('prenom préservé', loc.prenom === 'Pierre');
    check('adresse structurée', typeof loc.adresse === 'object' && loc.adresse.cp === '75005');
    check('loyerHC préservé', loc.loyerHC === 1200);
    check('charges préservé', loc.charges === 150);
    console.log();

    // 5. Crée un paiement en_attente
    console.log('[5/6] POST /api/paiements (créer paiement Sept 2026)...');
    const r2 = await req('POST', '/api/paiements', {
      locataireId, mois: 'Septembre', annee: 2026, total: 1350, statut: 'en_attente'
    });
    check('HTTP 200', r2.status === 200);
    const paiementId = r2.body.paiement.id;
    check('paiement créé', !!paiementId, `id=${paiementId}`);
    console.log();

    // 6. ENVOI EN UN CLIC
    console.log('[6/6] POST /api/paiements/envoyer (workflow complet)...');
    const r3 = await req('POST', '/api/paiements/envoyer', { paiementId, locataireId });
    check('HTTP 200', r3.status === 200, `status=${r3.status}, body=${JSON.stringify(r3.body).substring(0, 200)}`);
    check('ok=true', r3.body.ok === true);
    check('sha256 retourné', !!r3.body.sha256 && /^[a-f0-9]{64}$/.test(r3.body.sha256), `sha256=${r3.body.sha256?.slice(0, 16)}...`);
    check('filename généré', !!r3.body.filename && r3.body.filename.endsWith('.pdf'), `filename=${r3.body.filename}`);
    const apiSha = r3.body.sha256;

    // Vérif paiement passé à quittance_envoyee
    const paiementsFile = JSON.parse(fs.readFileSync(path.join(TMP_DATA, 'paiements.json'), 'utf-8'));
    const pmt = paiementsFile.find(p => p.id === paiementId);
    check('paiement statut=quittance_envoyee', pmt?.statut === 'quittance_envoyee');
    check('paiement pdfSha256 stocké', !!pmt?.pdfSha256 && pmt.pdfSha256 === apiSha);
    check('paiement dateEnvoiQuittance présent', !!pmt?.dateEnvoiQuittance);

    // ============ Vérif mail capturé ============
    console.log('\n=== Vérif mail capturé par le faux SMTP ===');
    check('1 mail capturé', capturedEmails.length === 1, `count=${capturedEmails.length}`);
    if (capturedEmails.length === 1) {
      const eml = fs.readFileSync(capturedEmails[0]);
      const emlStr = eml.toString('binary');
      console.log(`       Taille .eml: ${eml.length} octets`);

      // Vérifs header
      check('header X-PDF-SHA256 présent', /X-PDF-SHA256:/i.test(emlStr), emlStr.match(/X-PDF-SHA256:[^\r]*/i)?.[0]);
      const xSha = emlStr.match(/X-PDF-SHA256:\s*([a-f0-9]+)/i)?.[1];
      check('X-PDF-SHA256 = apiSha', xSha === apiSha, `header=${xSha?.slice(0, 16)}, api=${apiSha.slice(0, 16)}`);

      // Vérifs content-type PDF
      check('Content-Type PDF présent', /Content-Type:\s*application\/pdf/i.test(emlStr));

      // Extraction du PDF base64
      // Le boundary nodemailer est de la forme "----_NmP-XXX" (4 tirets + identifiant)
      // Stratégie : on trouve le "Content-Transfer-Encoding: base64" puis on lit
      // jusqu'à la prochaine ligne qui commence par "----"
      const cteIdx = emlStr.indexOf('Content-Transfer-Encoding: base64');
      let b64Text = null;
      if (cteIdx !== -1) {
        const after = emlStr.slice(cteIdx);
        // Skip headers jusqu'à la ligne vide
        const headerEnd = after.indexOf('\r\n\r\n');
        if (headerEnd !== -1) {
          const body = after.slice(headerEnd + 4);
          // body commence par le base64 ; on s'arrête à la première ligne "----..."
          const boundaryMatch = body.match(/\r?\n(----[A-Za-z0-9_=-]+)/);
          if (boundaryMatch) {
            b64Text = body.slice(0, boundaryMatch.index + boundaryMatch[0].length - boundaryMatch[1].length);
          } else {
            b64Text = body;
          }
        }
      }
      if (b64Text) {
        const pdfBuffer = Buffer.from(b64Text.replace(/\s/g, ''), 'base64');
        console.log(`       PDF décodé: ${pdfBuffer.length} octets`);
        check('magic bytes PDF', pdfBuffer.slice(0, 5).toString('latin1') === '%PDF-');
        const crypto = require('crypto');
        const realSha = crypto.createHash('sha256').update(pdfBuffer).digest('hex');
        check('SHA-256 du PDF capturé = apiSha', realSha === apiSha, `real=${realSha.slice(0, 16)}, api=${apiSha.slice(0, 16)}`);

        // Sauvegarde le PDF pour vérif visuelle
        const pdfOut = path.join(TMP_EMAILS, 'captured_quittance.pdf');
        fs.writeFileSync(pdfOut, pdfBuffer);
        console.log(`       PDF sauvé: ${pdfOut}`);

        // Vérif contenu textuel du PDF
        const text = pdfBuffer.toString('latin1');
        check('contient "QUITTANCE DE LOYER"', /QUITTANCE DE LOYER/.test(text));
        check('contient nom locataire', /Pierre.*Curie|Curie.*Pierre/.test(text));
        check('contient bloc signature SHA', /SHA-256|SHA256/i.test(text));
        check('contient mention loi ELAN', /ELAN/i.test(text));
      } else {
        check('PDF base64 extrait', false, 'pas de bloc base64 trouvé');
      }
    }

    console.log('\n=== Résultat final ===');
    console.log(allOK ? '✓ TOUS LES TESTS E2E PASSENT' : '✗ CERTAINS TESTS ONT ÉCHOUÉ');

  } catch (e) {
    console.error('ERREUR:', e.message);
    console.error(e.stack);
    allOK = false;
  } finally {
    server.close();
    smtpServer.close();
    try { fs.unlinkSync(path.join(__dirname, 'server/_sm_patched.js')); } catch {}
    process.exit(allOK ? 0 : 1);
  }
})();
