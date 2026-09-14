# FINDO 11.1 PRO — SPECIFIC LISTING ENGINE

- Marketplace results are now required to resolve to an individual listing/product URL.
- eBay `/p/` product-aggregation pages are rejected unless resolved to `/itm/`.
- Subito requires `/annunci/`, Vinted `/items/`, Facebook Marketplace `/marketplace/item/`, Amazon `/dp/` or `/gp/product/`, AutoScout24 individual `/annunci/` or `/offerte/`.
- Search/category/collection URLs are rejected before final ranking.
- Direct listing validation happens after page metadata enrichment, so the actual offer page is verified before the result is shown.
- Version: 11.1.0-PRO.
