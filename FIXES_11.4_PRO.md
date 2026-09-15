# FINDO 11.4 PRO — FAST PRECISION RECOVERY

- Fixed fallback search URL unwrapping for DDG/Brave redirect links.
- Expanded HTML result parsing for current result-title/result-header classes.
- Reduced marketplace provider fan-out: one request per primary/secondary lane instead of one request per marketplace.
- Keeps strict direct-listing validation while allowing pageMeta() to recover a real listing URL from a search page.
- Updated version to 11.4.0-PRO.
- Updated Node engine to 24.x for upcoming Vercel Node 20 deprecation.
- No secrets included.
