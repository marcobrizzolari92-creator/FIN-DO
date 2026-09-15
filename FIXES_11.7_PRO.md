# FINDO 11.7 PRO — VERIFIED LISTING ENGINE

## Root cause found
The previous search parser interpreted:

`Land Rover Discovery 4 meno di 200000 km`

as BOTH:
- maxMileage = 200000
- maxPrice = 200000

The price filter then rejected valid vehicle listings that did not expose a price in the search snippet/page metadata, producing zero results.

This is fixed: a numeric constraint followed by `km` is now treated only as mileage, never as price.

## Listing URL fix
Subito individual listings such as:
`/telefonia/iphone-16-128gb-brescia-652952728.htm`
are now accepted as direct listings. Collection/search roots remain rejected.

Also verified:
- eBay `/itm/` accepted
- Vinted `/items/` accepted
- AutoScout24 `/annunci/` and `/offerte/` individual paths accepted
- eBay `/p/` aggregation rejected
- Subito `/annunci` search root rejected

## Metadata
Listing page metadata now extracts, when available:
- price
- mileage
- year
- fuel
- address
- image

## Fallbacks
Bing RSS, Brave Search and DuckDuckGo are available as fallback web providers when Tavily is unavailable.

## Tests run
`node --check server.js` — PASS
`node --check index-html.js` — PASS
`/api/health` — PASS
`/api/selftest` — PASS

Self-test cases:
- iPhone 16 exact listing accepted
- iPhone 16 Pro rejected for an iPhone 16 base-model query
- Discovery 4 under 200,000 km accepted
- Discovery 4 over 200,000 km rejected
- Discovery Channel rejected
- direct marketplace URL classification verified
