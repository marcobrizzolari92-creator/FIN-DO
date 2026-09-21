# Deploy FINDO 11.8 PRO

1. Deploy the project to Vercel.
2. Set Production environment variables for the API keys you actually use.
3. Redeploy after changing environment variables; Vercel requires a redeploy for changes to take effect.
4. Open `/api/health` and verify version `11.8.0-PRO-AUTONOMOUS-LISTING`.
5. Open `/api/selftest` and verify `"ok": true` and an empty `failures` array.

Recommended web-search resilience:
- `TAVILY_API_KEY` or `TAVILY_API_KEYS` (primary)
- `GEMINI_API_KEY` or `GEMINI_API_KEYS` (Google Search grounding fallback)

Tavily is no longer treated as the only search path. If Tavily is exhausted/unavailable, FINDO tries public web fallbacks and then Gemini Google Search grounding when configured.

Important: no software can create or renew third-party API credentials without access to the provider account. When a provider quota is exhausted, the application can fail over to another provider, but it cannot manufacture a new paid quota.
