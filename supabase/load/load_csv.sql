-- Loads the three CSV files from the Colab download into the tables. Safe to re-run:
-- existing rows are left alone and only new rows are added.
-- Run with psql from the folder that holds the CSV files (see load/README.md).
\set ON_ERROR_STOP on
set statement_timeout = 0;
set timezone = 'UTC';
\timing off
begin;

create temp table s_spot (time_utc text, time_ist text, open numeric, high numeric, low numeric, close numeric, volume numeric);
\copy s_spot from 'btc_spot_1h.csv' with (format csv, header true)
insert into public.btc_spot_1h (ts, open, high, low, close, volume)
select (time_utc || ' UTC')::timestamptz, open, high, low, close, volume from s_spot
on conflict (ts) do nothing;

create temp table s_prod (symbol text, type text, strike numeric, expiry_utc text, expiry_ts bigint, spot_day_before numeric);
\copy s_prod from 'btc_options_products.csv' with (format csv, header true)
insert into public.option_contracts (symbol, option_type, strike, expiry_ts, spot_day_before)
select symbol, type, strike, to_timestamp(expiry_ts), spot_day_before from s_prod
on conflict (symbol) do nothing;

create temp table s_opt (symbol text, type text, strike numeric, expiry_utc text, time_utc text, time_ist text,
  hours_to_expiry numeric, open numeric, high numeric, low numeric, close numeric, volume numeric, source text);
\copy s_opt from 'btc_options_1h.csv' with (format csv, header true)
insert into public.option_candles_1h (symbol, ts, open, high, low, close, volume, kind)
select symbol, (time_utc || ' UTC')::timestamptz, open, high, low, close, volume,
       case when source = 'trade' then 'trade' else 'mark' end
from s_opt
on conflict (symbol, ts) do nothing;

commit;
analyze public.btc_spot_1h; analyze public.option_contracts; analyze public.option_candles_1h;
select * from public.v_data_coverage;
