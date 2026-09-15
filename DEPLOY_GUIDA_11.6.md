# Deploy FINDO 11.6

1. Carica il contenuto della cartella su Vercel.
2. Configura le variabili in **Production**.
3. Fai **Redeploy** dopo aver modificato le variabili: Vercel applica le nuove environment variables ai nuovi deployment.
4. Apri `/api/health` e verifica `version = 11.6.0-PRO-AUTONOMOUS-RECOVERY`.
5. Apri `/api/diagnostics` per vedere lo stato di Tavily, fallback web e adapter marketplace.

Il file `.env` non è incluso nel pacchetto.
