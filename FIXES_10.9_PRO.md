# FINDO 10.9 PRO

- Resilient provider layer: automatic retry, exponential backoff and Retry-After handling for Tavily.
- Automatic rotation across TAVILY_API_KEYS / GEMINI_API_KEYS when multiple keys are configured.
- Tavily Extract uses the same resilient provider layer instead of a single hard-coded key.
- Direct-announcement rescue uses the resilient Tavily layer.
- Gemini model fallback: GEMINI_MODELS defaults to gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash.
- Gemini retries across model/key combinations for temporary failures and unavailable/deprecated model IDs.
- API health endpoint exposes configured provider count and Gemini model fallback list without exposing secrets.
- Search remains usable when Gemini is unavailable because normal web search does not depend on Gemini.
- Modern UI cache/version bumped to 10.9.

## API setup

Set the keys once as server environment variables. Do not put them in the frontend. A single valid Tavily production/development key and a single valid Google Gemini API key can be kept indefinitely until the provider revokes/rotates it or the account/quota changes. Optional comma-separated backup keys can be added for automatic failover.
