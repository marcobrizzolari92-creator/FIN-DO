# FINDO 11.8 PRO — AUTONOMOUS LISTING ENGINE

## Root cause fixed
The previous listing filter called `looksLikeSearchPage()` before checking marketplace-specific individual listing formats. This caused valid Subito `/...-123456789.htm` and AutoScout24 `/annunci/...UUID` or `/offerte/...UUID` URLs to be classified as search pages and discarded.

## Changes
- Marketplace-specific URL detection now runs before generic search-page detection.
- Subito individual `.htm` listings are accepted; Subito category/search pages are rejected.
- AutoScout24 individual UUID listings are accepted; list pages are rejected.
- eBay `/itm/`, Vinted `/items/`, Amazon `/dp/` and `/gp/product/`, Facebook Marketplace `/marketplace/item/` are explicitly handled.
- Added Gemini Google Search grounding as a final web-search fallback when Tavily and public HTML/RSS fallbacks return nothing. Google documents that Gemini grounding can retrieve real-time web results and exposes `groundingChunks` with source URLs.
- Added DuckDuckGo to the public fallback pool.
- Added `/api/selftest` to verify listing/search URL classification before deployment.
- Node engine raised to `>=24` for new Vercel deployments.
- No API secrets are included in this ZIP.
