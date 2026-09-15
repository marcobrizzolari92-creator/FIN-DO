# Deploy FINDO 11.7

1. Replace the project source with this package.
2. Configure the existing API environment variables in Vercel for **Production**.
3. Redeploy the project after changing environment variables.
4. Open `/api/health` and confirm version `11.7.0-PRO-VERIFIED`.
5. Open `/api/selftest` and confirm `"ok": true`.
6. Then test real searches:
   - `iPhone 16`
   - `iPhone 16 meno di 600 euro`
   - `Land Rover Discovery 4 meno di 200000 km`

Do not copy an old `.env` into the package. API secrets are intentionally not included.
