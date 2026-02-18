# Website Optimizer PROD

Komplette Website-Optimierungs-Plattform mit:
- PostgreSQL Datenbank
- Automatische Lighthouse-Analyse
- Netlify Deployment
- Gmail-Versand

## Architektur

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────┐
│   User UI   │────▶│  Render Server  │────▶│  PostgreSQL  │
│  (GitHub)   │     │   (Node.js)     │     │   (Render)   │
└─────────────┘     └─────────────────┘     └──────────────┘
                             │
                             ▼
                      ┌─────────────────┐
                      │  Ares (AI)      │
                      │  - Crawlen      │
                      │  - Optimieren   │
                      │  - Lighthouse   │
                      │  - Deploy       │
                      └─────────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
        ┌────────────┐                ┌────────────┐
        │  Netlify   │                │   Gmail    │
        │  (Deploy)  │                │  (E-Mail)  │
        └────────────┘                └────────────┘
```

## Setup

### 1. Datenbank (Render)
- Neue PostgreSQL DB erstellen
- DATABASE_URL kopieren

### 2. Env Variablen
```bash
# Database
DATABASE_URL=postgresql://...

# Gmail OAuth2 (aus .secrets/gmail_token.json)
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_FROM=claraclaw@claraclaw.de

# Netlify
NETLIFY_TOKEN=...

# Admin
ADMIN_API_KEY=openssl rand -hex 32
```

### 3. Deploy
```bash
git push origin main
# Render auto-deploy bei Push
```

## Workflow

1. **User** gibt URL + Email ein
2. **Daten** werden in PostgreSQL gespeichert
3. **Ares** sieht pending jobs über API
4. **Ares** crawlt & optimiert Website
5. **Ares** deployed zu Netlify
6. **Ares** speichert Ergebnisse in DB
7. **Server** sendet Email an User
8. **Email** enthält Upsell-Angebot

## API Endpoints

| Endpoint | Auth | Beschreibung |
|----------|------|--------------|
| POST /api/jobs | Public | Job erstellen |
| GET /api/jobs/:id | Public | Status checken |
| GET /api/jobs/pending | Admin | Offene Jobs |
| POST /api/jobs/:id/lighthouse-before | Admin | Vorher-Test |
| POST /api/jobs/:id/lighthouse-after | Admin | Nachher-Test |
| POST /api/jobs/:id/complete | Admin | Job abschließen |
| POST /api/jobs/:id/deploy | Admin | Zu Netlify deployen |

## Admin Header
```
X-API-Key: dein_admin_key
```