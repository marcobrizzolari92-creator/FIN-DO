# 🚀 FINDO 7.0.0 — Guida Deploy su Vercel

## ⚡ Deploy Zero-Config (metodo ufficiale Vercel per Express)

Vercel supporta **zero-config** per Express: basta che il file `server.js`
sia nella root del progetto con `export default app`. Vercel lo rileva
automaticamente e lo trasforma in una serverless function.

I file statici in `public/` vengono serviti dalla CDN di Vercel.

**Non serve nessuna configurazione speciale** — `vercel.json` è `{}` (vuoto).

## 📁 Struttura del progetto

```
findo7/
├── server.js          ← Express 4 app (export default app)
├── vercel.json         ← {} (zero-config)
├── package.json        ← type: module, express 4, dotenv
├── public/
│   ├── index.html      ← PWA completa
│   ├── sw.js
│   ├── manifest.json
│   ├── icon-192x192.png
│   ├── icon-512x512.png
│   └── apple-touch-icon.png
├── .env.example
└── .gitignore
```

## 🔑 Variabili d'ambiente su Vercel

Nel dashboard Vercel → **Settings** → **Environment Variables**, aggiungi:

| Variabile | Valore | Obbligatoria |
|-----------|--------|-------------|
| `TAVILY_API_KEY` | `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` | ✅ Sì |
| `GOOGLE_MAPS_API_KEY` | `AIzaSyB1m7FOpNGXGe5iToTRnHMDkFJx2vQY6Hk` | ✅ Sì |
| `AMADEUS_CLIENT_ID` | *(vuoto per ora)* | ❌ No |
| `AMADEUS_CLIENT_SECRET` | *(vuoto per ora)* | ❌ No |

## 📋 Passi per il deploy

### Opzione A: Deploy tramite GitHub (CONSIGLIATO)

1. Pusha tutti i file su GitHub
2. Vai su [vercel.com/new](https://vercel.com/new)
3. Importa il repo
4. **⚠️ IMPORTANTE — Impostazioni Framework:**
   - Vercel dovrebbe rilevare automaticamente **Express** come framework
   - Se non lo rileva, seleziona **"Other"** come Framework Preset
   - **NON selezionare** "Next.js" o altri framework!
5. Build Command: **lascia vuoto**
6. Output Directory: **lascia vuoto**
7. Root Directory: **lascia vuoto** (se il repo contiene solo findo7) oppure `findo7` (se è una subdirectory)
8. Aggiungi le variabili d'ambiente (tabella sopra)
9. Clicca **Deploy**

### Opzione B: Deploy tramite Vercel CLI

```bash
# 1. Installa Vercel CLI
npm i -g vercel

# 2. Vai nella cartella del progetto
cd findo7

# 3. Deploy (la prima volta ti chiederà di loggarti)
vercel

# 4. Per il production deploy
vercel --prod
```

## ⚙️ Come funziona

- **Vercel auto-rileva** `server.js` come app Express (zero-config)
- I file in `public/` sono serviti dalla **CDN globale** di Vercel
- `express.static()` è ignorato su Vercel (i file statici passano dalla CDN)
- Il catch-all `app.get("*", ...)` in Express gestisce il routing lato client (SPA)
- Le API routes (`/api/*`) sono gestite da Express
- `app.listen()` è disabilitato su Vercel (verifica `process.env.VERCEL`)

## ❌ Problemi risolti

| Problema | Causa | Soluzione |
|----------|-------|----------|
| fsPath crash | `api/index.js` + rewrites confondeva il framework detector | ✅ Rimosso `api/`, zero-config |
| DEPLOYMENT_NOT_FOUND | `outputDirectory: "public"` → sito statico | ✅ Rimosso |
| 404 su tutte le route | `framework: "other"` + rewrites complessi | ✅ Rimosso, zero-config |
| Express 5 incompatibile | Vercel non supporta Express 5 | ✅ Downgrade a Express 4 |

## 🧪 Test locale

```bash
cd findo7
npm install
node server.js
# → FINDO 7.0.0 su http://localhost:3000
```

## 💰 Costo: **0 €**

Vercel Hobby plan (gratuito):
- 100 GB bandwidth/mese
- 100 GB-hours serverless execution
- Deploy illimitati

## 🔍 Verifica post-deploy

Dopo il deploy, controlla:
1. La homepage carica `index.html` dalla CDN
2. `/api/health` ritorna `{"ok":true,...}`
3. `/api/search?q=pizza+milano` ritorna risultati
4. Le icone PWA in `/icon-192x192.png` sono accessibili

## ⚠️ Se il deploy fallisce ancora

1. **Elimina il progetto Vercel vecchio** (findo1-1) dal dashboard
2. **Ri-importa il repo da GitHub** — questo pulisce ogni cache del framework detector
3. Assicurati che non ci sia una cartella `api/` nel repo
4. Verifica che `vercel.json` sia `{}` (vuoto)
