/**
 * Moteur PDF — génération de quittances de loyer.
 *
 * Reproduit la mise en page du template Roland :
 *   - titre H1 centré
 *   - adresse soulignée
 *   - phrase de quittance (propriétaire + locataire + somme en lettres)
 *   - tableau 3 colonnes (libellé | montant | "euros")
 *   - lieu + date
 *   - mention légale en italique petit
 *
 * Dépendance : jspdf (npm install jspdf)
 */

const { jsPDF } = require('jspdf');

// ============ Conversion chiffres → lettres (français) ============

const UNITS = ['', 'Un', 'Deux', 'Trois', 'Quatre', 'Cinq', 'Six', 'Sept', 'Huit', 'Neuf',
  'Dix', 'Onze', 'Douze', 'Treize', 'Quatorze', 'Quinze', 'Seize', 'Dix-sept', 'Dix-huit', 'Dix-neuf'];
const DIZAINES = ['', '', 'Vingt', 'Trente', 'Quarante', 'Cinquante', 'Soixante', 'Soixante', 'Quatre-vingt', 'Quatre-vingt'];

function toLetters999(n) {
  // 0..999
  if (n === 0) return '';
  let out = '';
  const centaines = Math.floor(n / 100);
  const reste = n % 100;
  if (centaines === 1) out += 'Cent';
  else if (centaines > 1) out += (UNITS[centaines] + ' cent' + (reste === 0 ? 's' : ''));
  // 1..16
  if (reste > 0 && reste < 17) {
    out += (out ? ' ' : '') + UNITS[reste];
  } else if (reste >= 17 && reste < 20) {
    out += (out ? ' ' : '') + 'Dix-' + UNITS[reste - 10];
  } else if (reste >= 20 && reste < 70) {
    const d = Math.floor(reste / 10);
    const u = reste % 10;
    out += (out ? ' ' : '') + DIZAINES[d] + (u === 1 ? ' et un' : (u > 0 ? '-' + UNITS[u] : (d === 2 || d === 3 || d === 4 || d === 5 || d === 6 ? '' : '')));
  } else if (reste >= 70 && reste < 80) {
    // 70-79 : "soixante-dix", "soixante et onze", etc.
    const u = reste - 60;
    out += (out ? ' ' : '') + 'Soixante';
    if (u === 11) out += ' et onze';
    else if (u < 17) out += '-' + UNITS[u];
    else out += '-' + UNITS[10] + '-' + UNITS[u - 10];
  } else if (reste >= 80 && reste < 100) {
    const d = Math.floor(reste / 10);
    const u = reste % 10;
    out += (out ? ' ' : '') + DIZAINES[d];
    out += (u === 0 ? 's' : (u === 1 ? ' et un' : '-' + UNITS[u]));
  }
  return out;
}

function toLetters(n) {
  // n est un nombre entier >= 0
  if (n === 0) return 'zéro';
  let out = '';
  const millions = Math.floor(n / 1_000_000);
  const milliers = Math.floor((n % 1_000_000) / 1000);
  const unites = n % 1000;
  if (millions > 0) {
    out += (millions === 1 ? 'un million' : toLetters999(millions) + ' millions');
  }
  if (milliers > 0) {
    out += (out ? ' ' : '') + (milliers === 1 ? 'mille' : toLetters999(milliers) + ' mille');
  }
  if (unites > 0) {
    out += (out ? ' ' : '') + toLetters999(unites);
  }
  return out;
}

function numberToFrenchLetters(num) {
  // Accepte 1000 ou "1000" ou 1234.56
  const n = typeof num === 'string' ? parseFloat(num) : num;
  if (!isFinite(n)) return '';
  const intPart = Math.floor(n);
  const decPart = Math.round((n - intPart) * 100);
  const lettres = toLetters(intPart);
  // Format original du template : "Mille euros / 1000" (lettres en MAJUSCULES dans le PDF)
  let out = lettres.toUpperCase() + ' EUROS';
  if (decPart > 0) {
    out += ' ET ' + toLetters(decPart).toUpperCase() + ' CENTIMES';
  }
  // Slash + valeur numérique exacte (format template)
  const numStr = decPart > 0
    ? `${intPart},${String(decPart).padStart(2, '0')}`
    : `${intPart}`;
  out += ' / ' + numStr + ' euros';
  return out;
}

// ============ Slug ============

function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // retire accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ============ Noms de mois ============

const MOIS_FR = ['', 'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

// ============ Génération PDF ============

function buildPdf(data) {
  const {
    proprietaire = 'Roland Ghaoui',
    locataire,
    adresse,
    mois,
    annee,
    loyerHC,
    charges,
    total,
    lieu = 'Bahreïn',
    dateEmission,
  } = data;

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const PAGE_W = 210;
  const MARGIN_L = 20;
  const MARGIN_R = 20;
  let y = 20;

  // Titre H1 centré, gras
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('QUITTANCE DE LOYER', PAGE_W / 2, y, { align: 'center' });
  y += 12;

  // H2 "Adresse de la location :" souligné
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Adresse de la location :', MARGIN_L, y);
  // souligner
  const w = doc.getTextWidth('Adresse de la location :');
  doc.setLineWidth(0.4);
  doc.line(MARGIN_L, y + 1.5, MARGIN_L + w, y + 1.5);
  y += 10;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(adresse, MARGIN_L, y);
  y += 12;

  // Phrase de quittance (peutaller à la ligne)
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  const phrase = `Je soussigné ${proprietaire} propriétaire du logement désigné ci-dessus, `
    + `déclare avoir reçu de ${locataire} la somme de ${numberToFrenchLetters(total)}, `
    + `au titre du paiement du loyer et des charges pour la période de location de tout le mois de ${mois} ${annee}.`;
  const phraseLines = doc.splitTextToSize(phrase, PAGE_W - MARGIN_L - MARGIN_R);
  doc.text(phraseLines, MARGIN_L, y);
  y += phraseLines.length * 6 + 6;

  // H2 "Détail du règlement" souligné
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Détail du règlement', MARGIN_L, y);
  const w2 = doc.getTextWidth('Détail du règlement');
  doc.line(MARGIN_L, y + 1.5, MARGIN_L + w2, y + 1.5);
  y += 10;

  // Tableau 3 colonnes
  const colX = [MARGIN_L, MARGIN_L + 90, MARGIN_L + 120];
  const rowH = 8;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);

  function row(libelle, montant, suffix) {
    doc.text(libelle, colX[0], y);
    doc.text(String(montant), colX[1], y, { align: 'right' });
    doc.text(suffix, colX[2], y);
    y += rowH;
  }

  row('Loyer HC :', loyerHC, 'euros');
  row('Provision pour charges :', charges, 'euros');
  // Total en gras
  doc.setFont('helvetica', 'bold');
  row('Total du loyer CC :', total, 'euros');
  doc.setFont('helvetica', 'normal');
  y += 6;

  // Lieu + date
  doc.text(`Fait à ${lieu}, le ${dateEmission}.`, MARGIN_L, y);
  y += 10;

  // Mention légale en italique petit
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  const mention = "Cette quittance annule tous les reçus qui auraient pu être établis précédemment en cas de "
    + "paiement partiel du montant du présent terme. Elle est à conserver pendant trois ans par le "
    + "locataire (article 7-1 de la loi n° 89-462 du 6 juillet 1989).";
  const mentionLines = doc.splitTextToSize(mention, PAGE_W - MARGIN_L - MARGIN_R);
  // En bas de page
  const bottomY = 280;
  doc.text(mentionLines, MARGIN_L, bottomY);

  // Retourne un Buffer (ArrayBuffer/Uint8Array de jsPDF.output)
  const out = doc.output('arraybuffer');
  return Buffer.from(out);
}

// ============ Nom de fichier ============

function buildFilename({ locataire, mois, annee }) {
  const slug = slugify(locataire);
  const m = MOIS_FR.indexOf(mois);
  const mm = m > 0 ? String(m).padStart(2, '0') : '00';
  return `quittance-${slug}-${annee}-${mm}.pdf`;
}

module.exports = {
  numberToFrenchLetters,
  slugify,
  buildPdf,
  buildFilename,
  MOIS_FR,
};