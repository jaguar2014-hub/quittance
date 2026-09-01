# Quittances de Loyer

Application locale pour générer et envoyer automatiquement les quittances de loyer.

## Démarrage

Double-cliquez sur **`launch.bat`**. C'est tout.

L'app s'ouvre dans votre navigateur. La première fois, l'installation prend ~30 secondes.

## Utilisation

1. **Onglet "Locataires"** — Ajoutez vos locataires (nom, email, adresse).
2. **Onglet "Nouvelle quittance"** — Choisissez le locataire, saisissez mois + loyer HC + charges.
3. Cliquez **"Générer le PDF"** → aperçu s'affiche.
4. Cliquez **"Envoyer par mail"** → confirmation → mail envoyé au locataire.

L'historique des envois est dans l'onglet **"Historique"**.

## Tester

```bash
npm test                  # tests frontend (38 tests, ~1s)
cd server && npm test     # tests backend SMTP (10 tests, ~1s)
```