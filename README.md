# Quittances de Loyer

Application web pour générer, signer et envoyer automatiquement les quittances de loyer.

Conforme à la loi n°89-462 du 6 juillet 1989 (article 21 + article 7-1). Signature numérique SHA-256 conforme loi ELAN.

## Démarrage local

```bash
npm install
npm start
```

Le serveur écoute sur `http://localhost:8766`.

## Authentification

Au choix, par variables d'environnement :

| Mode | Variables | Usage |
|---|---|---|
| **Login email/password** (par défaut) | `APP_LOGIN_EMAIL` + `APP_LOGIN_PASSWORD` (texte) ou `APP_LOGIN_PASSWORD_HASH` (SHA-256 hex) | Simple, suffit pour 1-3 personnes de confiance |
| **OAuth Google** | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_ALLOWED_EMAILS` (virgules) | Pour partager largement, whitelist par email |
| **Sans auth (dev)** | aucune des deux → mode `dev` ouvert | Pour tester localement sans config |

Sur Render, configurer dans Dashboard → Environment.

## Envoi mail

| Variable | Description |
|---|---|
| `SMTP_HOST` | défaut `smtp.gmail.com` |
| `SMTP_PORT` | défaut `465` (SSL) |
| `SMTP_USER` | expéditeur (si non vide, surcharge le profil bailleur) |
| `GMAIL_APP_PASSWORD` | mot de passe d'application Gmail 16 chars |

## Onglets

1. **Locataires** — Ajouter / éditer / suivre vos locataires (Brief A enrichi)
2. **Nouvelle quittance** — Générer le PDF, prévisualiser, envoyer en un clic
3. **Historique** — Toutes les quittances envoyées (toutes temporelles)
4. **Template** — Personnaliser le rendu de la quittance (mention légale, signature, etc.)
5. **Mon profil** — Vos informations bailleur (nom, email, adresse, téléphone, lieu)

## Tester

```bash
npm test                                            # tous les tests Jest
node tests/e2e-workflow.js                          # E2E bout-en-bout (avec faux SMTP local)
```

## PWA

L'app est installable comme une vraie application Android/iOS : ouvrez l'URL dans Chrome sur mobile → menu ⋮ → "Ajouter à l'écran d'accueil".
