# FINDO 10.6 PRO

## Direct listing / product links
- Added a two-stage direct-link resolver for search/category URLs.
- First stage reads canonical/OG metadata and scans page anchors for listing-looking URLs.
- Second stage performs a targeted same-domain search using the exact result title and selects a non-search URL matching the listing.
- Search/category/marketplace pages are strongly penalized in ranking; direct listing pages receive a stronger boost.
- The final direct URL is reused by title, preview image and purchase button.
- OG/Twitter preview images are recovered from the resolved listing whenever the source exposes them.
- Works across cars, shopping, visual search and barcode results through the shared metadata enrichment path.

## Discovery / vehicle queries
- Queries such as "Discovery 4 meno di 200000 km" keep mileage filtering and now prioritize resolvable individual listings rather than model/category pages.
- A result is not considered a high-quality destination when its URL is a generic search/listing page.

## Frontend
- Existing product image preview is preserved and now benefits from the resolved listing URL/metadata.
