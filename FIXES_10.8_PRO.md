# FINDO 10.8 PRO

- Resilienza API: retry con exponential backoff + jitter per Tavily e Gemini.
- Rotazione automatica tra più chiavi configurate in `TAVILY_API_KEYS` / `GEMINI_API_KEYS`.
- Fallback Tavily advanced -> basic.
- Rescue search quando una ricerca parallela restituisce zero risultati.
- Endpoint health espone lo stato dei provider senza esporre le chiavi.
- Frontend ritenta una ricerca una volta in caso di errore transitorio.
- UI aggiornata con layout moderno, glassmorphism leggero, cards più eleganti e anteprime più pulite.
- Cache/service worker versione 10.8.

Nota: FINDO non può creare o rigenerare autonomamente una chiave API valida del tuo account. Può però ruotare automaticamente più chiavi già configurate e riprovare gli errori temporanei. Gli errori 401/403 richiedono una chiave valida/restrizioni corrette.
