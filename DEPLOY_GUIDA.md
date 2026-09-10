# FINDO 9.0 — Deploy

## Locale
1. Copia `.env.example` in `.env`.
2. Inserisci le chiavi dei provider che vuoi usare: Tavily, Google Places, Amadeus e `GEMINI_API_KEY` per la ricerca fotografica.
3. `npm install`
4. `npm start`
5. Apri `http://localhost:3000`.

## Ricerca foto
La chiave Gemini resta solo sul server. FINDO ridimensiona la foto nel browser, invia una versione compressa e chiede a Gemini un risultato strutturato. L'API Gemini supporta input immagine inline; per immagini grandi Google raccomanda il File API. FINDO limita comunque la foto a una dimensione ridotta per una risposta rapida.

## Barcode
Lo scanner usa il `BarcodeDetector` quando disponibile e verifica prima i formati supportati dal browser; se non è disponibile usa ZXing. È disponibile anche la lettura da foto e l'inserimento manuale.

## Qualità della ricerca
FINDO 9 usa ricerca multi-sorgente, filtri di categoria, corrispondenza semantica, controllo del budget, penalizzazione dei risultati non pertinenti e priorità ai risultati che contengono modello/marca/codice cercati.

## FINDO 10.9 — API stabili

Imposta le variabili ambiente del server **una sola volta**:

- `TAVILY_API_KEY` = chiave Tavily principale per la ricerca web.
- `GEMINI_API_KEY` = chiave Google Gemini per ricerca visiva/interpretazione immagini.
- `GEMINI_MODELS` = opzionale; di default FINDO usa `gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash` e passa automaticamente al modello successivo se quello configurato non è disponibile.
- `TAVILY_API_KEYS` / `GEMINI_API_KEYS` = opzionali, più chiavi separate da virgola per failover automatico.

Le chiavi non sono inserite nel browser e non vanno inserite nel file `public/index.html`.

FINDO 10.9 gestisce automaticamente retry, `429 Retry-After`, errori temporanei, rotazione delle chiavi e fallback tra modelli Gemini. Una singola chiave valida resta configurata finché non viene revocata/ruotata dal provider o cambiano quota/piano: non va sostituita a ogni avvio.
