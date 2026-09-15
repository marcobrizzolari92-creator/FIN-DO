# FINDO 11.5 — Autonomous Provider Layer

FINDO no longer treats one API as a single point of failure. Search uses a provider broker:
1. Tavily when healthy.
2. Automatic cooldown/rotation for configured Tavily keys.
3. Bing RSS + Brave fallback when Tavily is unavailable or exhausted.
4. Results are merged and deduplicated before precision filtering.

## Important limitation
An application cannot safely create or renew a third-party API key by itself. API credentials belong to the provider account. FINDO can automatically detect a dead/limited key, stop wasting requests on it, rotate to another configured key, and continue with fallback providers, but new credentials must be issued by the provider/account owner.

For Vercel, changed environment variables only affect new deployments; redeploy after changing credentials.
