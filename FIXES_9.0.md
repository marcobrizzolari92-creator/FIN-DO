# FINDO 9.0 — Definitiva: ricerca precisa, foto e barcode

- BarcodeDetector inizializzato in modo sicuro con i formati realmente supportati dal browser.
- Fallback ZXing per scansione live e lettura barcode da foto.
- Validazione EAN/UPC con checksum.
- Lookup su Open Food Facts, Open Products Facts e Open Beauty Facts.
- Ricerca offerte vincolata al codice EAN quando disponibile.
- Ricerca visiva con Gemini multimodale e output strutturato (marca, modello, prodotto, variante, testo, barcode, query, confidence).
- Se la foto contiene un barcode, FINDO passa automaticamente alla ricerca barcode.
- Compressione lato client e limite JSON 16 MB.
- Ranking più severo e filtri di pertinenza per evitare risultati non inerenti.
- Ricerca multi-sorgente con query specifiche per acquisto e confronto prezzi.
- Versione 9.0.0.

Configurazione visiva:
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
