# Website Optimizer PROD v2

Website-Optimierungs-Service mit:
- **Google Sheets** als Datenbank
- **Gmail** für Kunden-E-Mails
- **Netlify** für Deployments (extern via Ares)

## Architektur

```
User UI (Render) → Google Sheets (DB) → Ares (AI Worker)
                                        ↓
                              ┌─────────┴─────────┐
                              ↓                   ↓
                          Netlify           Gmail (Kunde)
```

## Setup

### 1. Google Sheet erstellen
- Neue Spreadsheet: "Website Optimizer Jobs"
- Tabellenblatt: "Jobs"
- Kopiere die Sheet ID aus der URL:
  `https://docs.google.com/spreadsheets/d/`**SHEET_ID**`/edit`

### 2. Google Sheets API aktivieren
- Google Cloud Console → APIs & Services
- Google Sheets API aktivieren

### 3. Env Variablen (Render)

Siehe `.env.example` für alle benötigten Variablen.

**Wichtige Variablen:**
- `GOOGLE_SHEET_ID` - ID des Google Sheets
- `GOOGLE_ACCESS_TOKEN` - Aktueller Access Token
- `GMAIL_*` - OAuth2 Credentials für E-Mail
- `ADMIN_API_KEY` - Für Admin-Endpunkte

## Workflow

1. **User** gibt URL + Email ein
2. **Server** speichert in Google Sheets
3. **Ares** ruft `/api/jobs/pending` (mit Admin Key)
4. **Ares** crawlt & optimiert Website
5. **Ares** speichert Lighthouse-Scores
6. **Ares** deployed zu Netlify
7. **Ares** ruft `/api/jobs/:id/complete`
8. **Server** sendet E-Mail an Kunden

## API Endpoints

| Endpoint | Auth | Beschreibung |
|----------|------|--------------|
| POST /api/jobs | Public | Job erstellen |
| GET /api/jobs/:id | Public | Status checken |
| GET /api/jobs/pending | Admin | Offene Jobs |
| POST /api/jobs/:id/lighthouse-before | Admin | Vorher-Score |
| POST /api/jobs/:id/lighthouse-after | Admin | Nachher-Score |
| POST /api/jobs/:id/complete | Admin | Abschließen + E-Mail |

## Admin Header
```
X-API-Key: dein_admin_key
```