# Configuration OAuth Google (5 minutes)

L'app utilise Google OAuth pour vous authentifier. Vous seul (et les emails que vous
ajoutez à la whitelist) pourrez y accéder.

## Étape 1 — Créer un projet Google Cloud

1. Allez sur https://console.cloud.google.com
2. En haut à gauche : sélecteur de projet → "Nouveau projet"
3. Nom : `quittances-app`
4. Créez

## Étape 2 — Activer l'API Google+

1. Menu hamburger → "APIs & Services" → "Library"
2. Cherchez "Google Identity" ou "Google+ API" (les deux marchent)
3. Cliquez "Enable"

## Étape 3 — Créer les identifiants OAuth

1. Menu → "APIs & Services" → "Credentials"
2. "+ CREATE CREDENTIALS" → "OAuth client ID"
3. Si demandé, configurez d'abord l'écran de consentement :
   - User type : "External"
   - App name : "Quittances de Loyer"
   - User support email : votre email
   - Developer contact : votre email
   - Save
   - "Add users" (test users) : ajoutez vos 2 emails (Jaguar2014@gmail.com et pat.gh777@gmail.com)
4. Retour à Credentials → "+ CREATE CREDENTIALS" → "OAuth client ID"
5. Application type : "Web application"
6. Name : `quittances-app-render`
7. **Authorized redirect URIs** (IMPORTANT) :
   ```
   https://quittances-app.onrender.com/auth/google/callback
   ```
   (vous adapterez l'URL après le premier déploiement Render si l'URL est différente)
8. "Create"
9. **Copiez le Client ID et Client Secret** — vous en aurez besoin pour Render

## Étape 4 — Configurer Render

Quand vous déployez sur Render (voir DEPLOY.md), ajoutez ces variables d'environnement :

| Variable | Valeur |
|---|---|
| `GOOGLE_CLIENT_ID` | le Client ID copié à l'étape 3.9 |
| `GOOGLE_CLIENT_SECRET` | le Client Secret copié à l'étape 3.9 |
| `GOOGLE_ALLOWED_EMAILS` | `Jaguar2014@gmail.com,pat.gh777@gmail.com` (séparés par virgule) |
| `PUBLIC_BASE_URL` | l'URL Render de votre service (ex: `https://quittances-app.onrender.com`) |
| `GMAIL_APP_PASSWORD` | le mot de passe d'application Gmail 16 chars (déjà dans `~/.himalaya_pass.txt`) |

## Étape 5 — Mettre à jour la redirect URI

Une fois l'app déployée sur Render et que vous connaissez l'URL finale :
1. Retournez sur Google Cloud Console > Credentials > votre OAuth client
2. "Edit" > Authorized redirect URIs
3. Ajoutez la vraie URL (ex: `https<VOTRE-URL>.onrender.com/auth/google/callback`)
4. Save

---

**C'est tout.** Maintenant, en visitant l'app, vous verrez "Se connecter avec Google",
vous choisissez votre compte, et l'app se charge.