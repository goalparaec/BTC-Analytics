# Supabase database

Holds the BTC data for analysis and for the dashboard's History panel.

| Table / view | What it holds |
|---|---|
| `btc_spot_1h` | BTC hourly spot candles (UTC) |
| `option_contracts` | one row per Delta option: type, strike, expiry |
| `option_candles_1h` | hourly mark-price candles per option |
| `v_option_candles` | candles joined to contracts, with IST time and hours to expiry |
| `btc_daily_530` | one row per 5:30 PM to 5:30 PM IST day: open, close, high, low, range, move |
| `btc_hourly_activity` | average range by IST hour, weekday and weekend |
| `v_data_coverage` | row counts and date range |

Everything is readable with the public anon key (row level security). Only the database owner can write.

## Set up (once)
1. Supabase: New project. Save the database password.
2. Open `supabase/load/load_to_supabase.ipynb` in Google Colab (File, Open notebook, GitHub tab) and run all cells.
   It creates the tables and loads the CSV zip. Safe to run again.
3. Vercel: add `SUPABASE_URL` and `SUPABASE_ANON_KEY` (see `.env.example`), then redeploy.

## Migrations
`supabase/migrations/*.sql` are the schema history, in order. They are repeatable. To use the Supabase CLI instead of Colab:
`supabase link --project-ref YOUR_REF` then `supabase db push`.
After changing the schema, add a new migration file. Never edit one that has already been applied.
If you change a migration file, run `python3 supabase/build_notebook.py` so the notebook matches.

## Daily automatic data (GitHub Actions)
`.github/workflows/collect-delta.yml` runs every day at 7:00 PM IST (after the 5:30 PM expiry). It reads the newest data already in Supabase, downloads what is new from Delta (`collector/collect_delta.py`), and loads it with `supabase/load/load_csv.sql`.
- Free. Nothing to keep running.
- If a day fails, the next run fills it in. Days are saved whole or not at all, so there are no half days.
- A failed run shows a red cross in the repo's Actions tab and GitHub emails you.
- Set up once: repo Settings, Secrets and variables, Actions, add `PGHOST`, `PGUSER`, `PGPASSWORD` (the Session pooler values). Then Actions, Collect Delta data, Run workflow, to test it.
- GitHub pauses scheduled runs on a public repo after 60 days with no repo activity. If you get that email, click Enable on the Actions tab.
- Strikes stay within 3,000 points of spot, the same as the history.

## Adding data by hand
Run the Colab downloader, then run the loader notebook with the new zip. Existing rows are skipped.
