/**
 * Étape 3 — RED : tests du backend SMTP.
 * Le module send-mail.js n'existe pas encore → ces tests doivent FAIL.
 */
const path = require('path');

// Mock nodemailer AVANT require
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(),
}));

const nodemailer = require('nodemailer');

describe('Étape 3 — backend SMTP', () => {
  let sendMail;
  let mockSendMail;
  let mockVerify;

  beforeAll(() => {
    mockSendMail = jest.fn();
    mockVerify = jest.fn((cb) => cb(null, true));
    nodemailer.createTransport = jest.fn(() => ({
      sendMail: mockSendMail,
      verify: mockVerify,
    }));
    sendMail = require('../send-mail');
  });

  beforeEach(() => {
    mockSendMail.mockReset();
  });

  describe('exports', () => {
    test('expose une fonction sendMail({to, subject, body, pdfBase64, filename})', () => {
      expect(typeof sendMail.sendMail).toBe('function');
    });
    test('expose une fonction loadConfig()', () => {
      expect(typeof sendMail.loadConfig).toBe('function');
    });
    test('expose une fonction buildApp() (Express)', () => {
      expect(typeof sendMail.buildApp).toBe('function');
    });
  });

  describe('loadConfig', () => {
    test('charge la config depuis le fichier himalaya_pass.txt (utilisateur=Agent)', () => {
      const cfg = sendMail.loadConfig();
      expect(cfg.user).toBe('Jaguar2014@gmail.com');
      expect(cfg.pass).toMatch(/^[a-z]{16}$/);
      expect(cfg.host).toBe('smtp.gmail.com');
    });
  });

  describe('sendMail (nodemailer mocké)', () => {
    test('appelle transporter.sendMail avec les bons arguments', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'abc123', response: '250 OK' });

      const result = await sendMail.sendMail({
        to: 'locataire@example.com',
        subject: 'Quittance Janvier 2026',
        body: '<p>Bonjour</p>',
        pdfBase64: Buffer.from('PDF-CONTENT').toString('base64'),
        filename: 'quittance.pdf',
      });

      expect(mockSendMail).toHaveBeenCalledTimes(1);
      const args = mockSendMail.mock.calls[0][0];
      expect(args.to).toBe('locataire@example.com');
      expect(args.subject).toBe('Quittance Janvier 2026');
      expect(args.attachments).toBeDefined();
      expect(args.attachments[0].filename).toBe('quittance.pdf');
      expect(args.attachments[0].content.equals(Buffer.from('PDF-CONTENT'))).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.messageId).toBe('abc123');
    });

    test('renvoie ok:false si nodemailer throw', async () => {
      mockSendMail.mockRejectedValue(new Error('SMTP timeout'));

      const result = await sendMail.sendMail({
        to: 'x@x.com', subject: 'x', body: 'x', pdfBase64: 'AAAA', filename: 'x.pdf',
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/SMTP timeout/);
    });
  });

  describe('API Express', () => {
    test('GET /api/health → {ok:true}', () => {
      const app = sendMail.buildApp();
      // mini test via supertest ou via mock http
      const supertest = require('supertest');
      return supertest(app)
        .get('/api/health')
        .expect(200)
        .expect(res => {
          expect(res.body.ok).toBe(true);
        });
    });

    test('POST /api/send sans champs requis → 400', () => {
      const app = sendMail.buildApp();
      const supertest = require('supertest');
      return supertest(app)
        .post('/api/send')
        .send({})
        .expect(400);
    });

    test('POST /api/send valide avec mock nodemailer → 200', async () => {
      mockSendMail.mockResolvedValue({ messageId: 'm1', response: '250 OK' });
      const app = sendMail.buildApp();
      const supertest = require('supertest');
      const res = await supertest(app)
        .post('/api/send')
        .send({
          to: 'romain@example.com',
          subject: 'Quittance',
          body: '<p>Bonjour</p>',
          pdfBase64: Buffer.from('%PDF-1.4 fake').toString('base64'),
          filename: 'quittance.pdf',
        })
        .expect(200);
      expect(res.body.ok).toBe(true);
    });

    test('POST /api/send avec SMTP en échec → 500', async () => {
      mockSendMail.mockRejectedValue(new Error('Auth failed'));
      const app = sendMail.buildApp();
      const supertest = require('supertest');
      const res = await supertest(app)
        .post('/api/send')
        .send({
          to: 'romain@example.com',
          subject: 'Q',
          body: 'b',
          pdfBase64: Buffer.from('x').toString('base64'),
          filename: 'q.pdf',
        })
        .expect(500);
      expect(res.body.ok).toBe(false);
    });
  });
});