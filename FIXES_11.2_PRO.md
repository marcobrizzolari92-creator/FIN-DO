# FINDO 11.2 PRO — LISTING RECOVERY

## Fix principale
La 10.21 classificava erroneamente `/annunci/` e `/offerte/` come pagine di ricerca. Questo faceva scartare proprio gli URL delle singole inserzioni di Subito, AutoScout24 e Automobile.it.

11.2 corregge il rilevamento: `/annunci/` e `/offerte/` possono essere inserzioni singole; vengono mantenuti i filtri per le vere pagine search/category e per eBay `/p/`, Amazon `/gp/search`, ecc.

Versione server: `11.2.0-PRO`.
