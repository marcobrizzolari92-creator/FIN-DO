# FINDO 11.3 PRO — VERIFIED LISTING ENGINE

## Fix principale
La 11.2 poteva eliminare tutti i risultati validi perché la funzione che riconosceva le pagine generiche considerava anche i percorsi usati dalle singole inserzioni.

11.3 separa correttamente:
- pagine di ricerca/categoria/aggregazione;
- singole inserzioni/prodotti.

## Marketplace verificati dal motore
- Subito: `/annunci/`
- Vinted: `/items/`
- eBay: `/itm/`
- Amazon: `/dp/` e `/gp/product/`
- Facebook Marketplace: `/marketplace/item/`
- AutoScout24: `/annunci/` e `/offerte/`
- Automobile.it: `/annunci/`, `/auto/`, `/offerte/`

## Precisione Shopping
Un prodotto usato non viene più considerato automaticamente irrilevante: viene escluso solo se contrasta con l'intento dell'utente.

## Fallback
Quando Tavily non è disponibile, FINDO usa i provider web di fallback senza trasformare una pagina generica in un'inserzione valida.

## Verifica eseguita
- `node --check server.js` OK.
- avvio locale del server OK.
- `/api/health` restituisce `11.3.0-PRO`.
- test end-to-end simulato di una ricerca `iPhone 16`: 9 risultati individuali restituiti, inclusi URL `/itm/`, `/annunci/`, `/items/`, `/dp/` e `/marketplace/item/`.

Le chiavi API non sono incluse nel pacchetto. Configurare le proprie variabili d'ambiente in locale/Vercel.
