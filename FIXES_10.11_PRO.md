# FINDO 10.11 PRO

Correzioni mirate al problema "non cerca":
- normalizzazione corretta dei domini Tavily: `facebook.com/marketplace` non viene più passato come dominio invalido a `include_domains`;
- barcode usa la stessa rilevazione/rotazione delle chiavi Tavily del motore principale;
- aggiunto `/api/diagnostics` per verificare in modo sicuro se Vercel vede le chiavi e se Tavily/Gemini rispondono davvero, senza mostrare le chiavi;
- versione PWA aggiornata a 10.11 per evitare cache della vecchia ricerca;
- `.env` distribuito senza credenziali.
