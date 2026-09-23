/**
 * Configuration Jest — Brief C
 *
 * Étend moduleDirectories pour que les tests placés à la racine (tests/*.test.js)
 * puissent résoudre les modules npm installés dans server/node_modules
 * (notamment nodemailer, requis par server/send-mail.js et mocké par step8).
 *
 * Ce fichier ne remplace pas la config par défaut, il l'augmente seulement.
 */
module.exports = {
  moduleDirectories: ['node_modules', 'server/node_modules', '<rootDir>/node_modules'],
};