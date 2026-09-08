# FINDO 8.0 — Foto e Barcode sistemati

Correzioni principali:
- scanner barcode: BarcodeDetector nativo + fallback ZXing per EAN/UPC/Code128/QR;
- ricerca barcode: lookup diretto EAN su Open Food Facts / Open Products Facts, poi confronto prezzi via Tavily;
- ricerca foto: immagine realmente analizzata da Gemini quando `GEMINI_API_KEY` è configurata;
- foto ridimensionate/compressse prima dell'invio, evitando payload troppo grandi;
- server JSON portato a 12 MB;
- `index-html.js` rigenerato per Vercel;
- versione/cache aggiornata a 8.0.

Per la ricerca visiva serve una chiave Gemini nell'ambiente:
`GEMINI_API_KEY=...`
`GEMINI_MODEL=gemini-2.5-flash`

Il barcode funziona anche senza Gemini. Tavily resta necessario per il confronto prezzi online.
