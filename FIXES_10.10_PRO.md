# FINDO 10.10 PRO

- Ridotto drasticamente il numero di richieste Tavily concorrenti per singola ricerca.
- Ricerca Shopping: richieste locali aggregate per dominio invece di una richiesta per ogni marketplace.
- Ricerca globale usata come fallback quando i primi risultati sono insufficienti.
- Gestione Tavily con retry/backoff e fallback basic/advanced.
- `country` passato a Tavily per favorire i risultati del paese richiesto.
- Mantenuti ricerca contestuale, ranking, visual search, barcode, immagini e resolver dei link.
- Versione server 10.10.0-PRO.
- `.env` distribuito senza credenziali: inserire le proprie chiavi solo localmente e configurarle in Vercel come Environment Variables.
