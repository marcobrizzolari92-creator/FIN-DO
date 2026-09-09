# FINDO 10.0 PRO

- Eliminato il problema Gemini MAX_TOKENS con output visivo molto più compatto.
- Retry automatico Gemini quando la risposta è troncata.
- Recupero di campi da JSON parzialmente troncato come ultima difesa.
- Timeout Gemini 20s e Tavily 15s per evitare schermate bloccate.
- Ricerca Tavily resiliente: un errore di una sorgente non interrompe tutta la ricerca.
- Fallback automatico sulla descrizione dell’utente se la ricerca visiva non trova offerte.
- Messaggi utente puliti: mai più mostrare direttamente MAX_TOKENS.
- Frontend embedded sincronizzato con public/index.html.
- Cache PWA aggiornata a v10.0.
