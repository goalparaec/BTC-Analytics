# BTC Options Desk

Read-only dashboard for BTC options on Delta Exchange India. It places no orders and holds no API keys.

## What it shows
- Delta option chain, break-even and expected-move numbers, countdown to the 5:30 PM IST expiry
- BTC price from Delta plus Coinbase, Kraken, Bitstamp, Binance and OKX, cross-checked
- Realised volatility from Delta 1-minute candles, Deribit DVOL and Deribit implied volatility
- Funding and open interest on Binance, Bybit, OKX, Deribit and Delta
- Scheduled events from official Fed and BLS calendars
- Colour-coded market signals (trend, option price vs realised vol, funding, venue agreement, events, data health)
- History panel from Supabase: typical 5:30 PM to 5:30 PM move, last 14 days, weekday and hourly activity (optional)

Every source shows its own age. Stale or failed sources are marked and left out of calculations.

## Layout
- `api/snapshot.js` the data endpoint the page polls every 10 seconds
- `api/health.js` per-source status with a raw response sample (use after deploying)
- `lib/` source adapters, pure calculations (`calc.js`), time rules (`time.js`), events (`events-data.js`)
- `public/` the page (no build step)
- `api/history.js` history from Supabase (optional)
- `supabase/` database migrations, Colab loader and notes (see `supabase/README.md`)
- `test/` tests: `npm test`

## Deploy
1. Put these files in the GitHub repo (main branch).
2. In Vercel: Add New, Project, import the repo. Framework preset: **Other**. Leave build command and output directory empty. Deploy.
3. Open `https://YOUR-APP.vercel.app/api/health`. Every row should say `"ok": true`.
   - A row with `"ok": false` shows why (for example HTTP 451 means that exchange blocks the server's region).
   - Copy the whole health page and send it to Claude if anything is red or looks wrong.
4. Open the main page.

`vercel.json` runs the functions in Mumbai (`bom1`).

## Connect Supabase (optional)
The page works without it. To turn on the History panel, follow `supabase/README.md`, then in Vercel add `SUPABASE_URL` and `SUPABASE_ANON_KEY` and redeploy. Use the anon/publishable key only, never the service_role key.

## Keep it accurate
- Events live in `lib/events-data.js`. Add a row only with an official source link, then run `npm test`.
- Formulas live in `lib/calc.js` and are versioned (`CALC_VERSION`). Change a formula, bump the version, update the tests.
- The tests use made-up exchange responses. They prove the logic, not that the exchanges still answer in the same shape. `/api/health` is the live check.

## Limits
- Polling every 10 seconds, not a live stream. Live liquidation streams need an always-on server.
- History covers the downloaded year. Live IV percentile needs a scheduled collector writing snapshots to Supabase (not built yet).
- Delta's funding-rate units are shown raw until confirmed against Delta's docs.
