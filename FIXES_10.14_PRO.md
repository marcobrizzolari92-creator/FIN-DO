# FINDO 10.14 PRO

- Diagnosed live deployment: Tavily returns HTTP 432 because the Tavily plan usage limit is exhausted.
- FINDO no longer fails hard when Tavily is unavailable: web search falls back automatically to DuckDuckGo HTML search.
- Tavily remains preferred when available.
- Added DuckDuckGo live status to /api/diagnostics.
- Gemini 503 is treated as a temporary AI-provider outage; basic web search does not depend on Gemini.
- Frontend/service-worker cache version bumped to 10.14.
