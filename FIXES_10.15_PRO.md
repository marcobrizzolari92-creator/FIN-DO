# FINDO 10.15 PRO

- Tavily HTTP 432 is treated as provider exhaustion, not as a fatal search failure.
- Reworked no-key fallback: DuckDuckGo HTML + DuckDuckGo Lite with tolerant parsers.
- If a domain-filtered fallback returns nothing, FINDO retries DuckDuckGo without domain filters.
- Fallback results are not discarded by strict product-kind enforcement at the parser stage; ranking/enrichment handles relevance later.
- Frontend/service-worker cache bumped to 10.15.
- No API credentials included.
