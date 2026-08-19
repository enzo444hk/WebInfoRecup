# Veridia — portail + journal live + e-mail quotidien

Portail de connexion avec :

- Inscription / connexion (mot de passe **haché** scrypt)
- Sessions par cookie
- Vérification automatique des capteurs (localisation, caméra, micro) — **sans bouton**
- Journal d’événements en direct (Server-Sent Events)
- **Envoi automatique par e-mail** du rapport des 24 dernières heures, tous les jours

Aucune base externe : stockage dans `data/db.json`.

## Démarrage local

```bash
git clone <ton-repo-prive>
cd veridia-github   # ou le nom de ton dossier
cp .env.example .env
# Édite .env (voir section Gmail ci-dessous)
npm install
npm start
```

Ouvre **http://localhost:3000**

## Configuration e-mail (Gmail)

1. Active la **validation en 2 étapes** sur le compte Google.
2. Crée un **mot de passe d’application** :  
   https://myaccount.google.com/apppasswords  
   (choisis « Autre » → nomme-le « Veridia »)
3. Dans `.env` :

```env
MAIL_TO=enzodd02@gmail.com
MAIL_FROM=enzodd02@gmail.com
SMTP_USER=enzodd02@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx   # le mot de passe d'application (16 caractères)
MAIL_CRON=0 8 * * *             # tous les jours à 08:00
TZ=Europe/Paris
```

Le serveur envoie alors chaque jour à 08:00 (heure de Paris) un e-mail avec les événements des 24 h précédentes.

### Tester l’envoi manuellement

```bash
curl -X POST http://localhost:3000/api/send-report
```

(ou avec un secret si tu définis `ADMIN_SECRET` dans `.env`)

## Déployer (pour que le cron tourne 24/7)

Le cron ne fonctionne que **tant que le processus Node tourne**. Sur ta machine, si tu fermes le terminal, plus d’e-mails.

Options simples pour un dépôt GitHub privé :

| Hébergeur     | Gratuit ? | Cron natif | Notes                          |
|---------------|-----------|------------|--------------------------------|
| [Railway](https://railway.app) | oui (crédits) | oui     | Branche le repo, ajoute les variables d’env |
| [Render](https://render.com)   | oui (sleep)  | oui     | Web Service + env vars         |
| [Fly.io](https://fly.io)       | oui          | oui     | `fly launch`                   |
| VPS (OVH, Hetzner…)            | payant       | systemd + cron | Le plus stable            |

Sur ces plateformes : pousse le repo, configure les variables d’environnement (celles de `.env`), et le service reste allumé → l’e-mail part tous les jours.

## Structure

```
server.js          API + SSE + cron e-mail
public/index.html  Frontend (permissions auto)
data/db.json       Comptes + événements (ignoré par git)
.env               Secrets (ignoré par git)
.env.example       Modèle à copier
```

## Sécurité

- Mots de passe **jamais** stockés en clair (scrypt).
- Cookies de session `HttpOnly`.
- `.env` et `data/db.json` sont dans `.gitignore` → ne partent pas sur GitHub.
- Pour la production : HTTPS obligatoire (sinon géoloc / caméra / micro bloqués hors localhost).

## Licence

Usage privé / personnel.
