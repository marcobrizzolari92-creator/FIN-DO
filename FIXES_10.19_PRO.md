# FINDO 10.19 PRO — Precision Search Engine

## Obiettivo
Ridurre drasticamente i risultati generici e privilegiare inserzioni/prodotti reali che corrispondono ai vincoli della richiesta.

## Correzioni principali
- Corretto un difetto nelle espressioni regolari di `hardRelevant`: alcuni confini di parola erano stati serializzati come carattere di backspace invece di `\b`, rendendo inefficaci diversi filtri semantici/categoria.
- La verifica dei vincoli non viene più fatta soltanto sullo snippet del motore di ricerca. I candidati vengono prima arricchiti dalla pagina sorgente quando possibile.
- Prezzo, chilometraggio, anno e URL diretto vengono verificati prima del filtro finale.
- Aggiunto un secondo controllo finale dopo l'arricchimento: un risultato viene restituito solo se continua a rispettare l'intento e la categoria richiesta.
- Il recupero dell'URL diretto resta prioritario per prodotti, auto e moto.

## Principio
Meglio pochi risultati realmente pertinenti che molti risultati generici.

Versione server: `10.19.0-PRO`
