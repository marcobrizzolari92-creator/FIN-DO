# FINDO 11.6 PRO — AUTONOMOUS RECOVERY

## Correzione del problema "nessun risultato"

- Le inserzioni singole non vengono più confuse con pagine generiche: `/annunci/`, `/offerte/`, `/itm/`, `/items/`, `/dp/` vengono riconosciuti secondo il dominio.
- Tavily 432 viene messo in cooldown per 5 minuti invece di essere interrogato inutilmente a ogni ricerca.
- Quando Tavily non è disponibile, FINDO non si blocca: usa in parallelo motori web pubblici e adapter diretti per marketplace.
- Aggiunti adapter diretti per Amazon, eBay, Subito, Vinted, AutoScout24, Automobile.it, Moto.it, Immobiliare.it e Idealista.it.
- Gli adapter estraggono direttamente i link alle singole inserzioni/prodotti dalle pagine dei marketplace.
- Ridotti i timeout e rimossa la seconda ondata di ricerca che rallentava FINDO senza aumentare realmente i risultati.
- Il recupero autonomo non richiede Tavily/Gemini per la ricerca testuale ordinaria. Gemini resta opzionale per ricerca visuale/barcode.
- Diagnostica aggiornata con `directMarketplaceLive`.
- Versione server: `11.6.0-PRO-AUTONOMOUS-RECOVERY`.

## Nota API

FINDO non può generare nuove chiavi API dei provider. Può però rilevare provider guasti, metterli in cooldown e continuare con i percorsi di recupero disponibili.
