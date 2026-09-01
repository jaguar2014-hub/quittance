# Déploiement sur Render (gratuit, sécurisé)

## Pré-requis
- Un compte GitHub : https://github.com/signup (gratuit)
- Un token GitHub avec scope `repo` (voir TELEGRAM message de Hermes)
- Un compte Render : https://render.com/signup (signin avec GitHub, gratuit)

## Étape 1 — Pousser le code sur GitHub

Hermes s'en charge quand vous donnez le token.

## Étape 2 — Créer le service sur Render

1. Allez sur https://dashboard.render.com/
2. "New" → "Blueprint"
3. Sélectionnez le repo GitHub que vous venez de créer (ou le nom qu'Hermes lui a donné)
4. Render détecte `render.yaml` automatiquement
5. Cliquez "Apply"
6. Render crée le service et vous demande de remplir les **Environment Variables secrètes** :
   - `GMAIL_APP_PASSWORD` : mot de passe d'application Gmail (16 chars)
   - `PUBLIC_BASE_URL` : `https://<service-name>.onrender.com`
   - `GOOGLE_CLIENT_ID` : depuis Google Cloud Console (voir GOOGLE_OAUTH_SETUP.md)
   - `GOOGLE_CLIENT_SECRET` : idem
7. Confirmez → Render build et démarre automatiquement (~2 min)

## Étape 3 — Configurer Google Cloud Console

Une fois l'URL connue (ex: `https://quittances-app-xyz.onrender.com`) :
1. Retournez sur Google Cloud Console > Credentials > votre OAuth client
2. Ajoutez cette URL dans "Authorized redirect URIs" :
   ```
   https://quittances-app-xyz.onrender.com/auth/google/callback
   ```
3. Save

## Étape 4 — Tester

Ouvrez l'URL Render dans votre navigateur. Vous devez voir :
- Bouton "Se connecter avec Google"
- Après login : l'app de gestion des quittances

## Limites du plan gratuit Render

- Le service **s'éteint après 15 minutes d'inactivité** → le 1er chargement prend ~30s
- 750 heures/mois de calcul (largement assez pour cette app)
- 1 GB de stockage pour les données (très largement assez)

Pour ne pas subir le sleep, vous pouvez :
- Visiter l'app régulièrement (chaque fois que vous l'utilisez)
- Ou upgrade vers le plan Starter ($7/mois)