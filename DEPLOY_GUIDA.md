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
