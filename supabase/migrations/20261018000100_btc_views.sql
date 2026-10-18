-- Analysis views. security_invoker makes them obey the caller's row level security.

-- Every option candle with its contract details, IST time and hours to expiry.
create or replace view public.v_option_candles with (security_invoker = on) as
select
  c.symbol,
  k.option_type,
  k.strike,
  k.expiry_ts,
  c.ts,
  (c.ts at time zone 'Asia/Kolkata')                           as ts_ist,
  extract(epoch from (k.expiry_ts - c.ts)) / 3600.0            as hours_to_expiry,
  c.open, c.high, c.low, c.close, c.volume, c.kind
from public.option_candles_1h c
join public.option_contracts k using (symbol);

-- The trading day: 5:30 PM IST to 5:30 PM IST (12:00 UTC to 12:00 UTC). Complete 24-candle windows only.
-- window_end is the expiry that closes the window.
create or replace view public.btc_daily_530 with (security_invoker = on) as
with w as (
  select
    -- computed in UTC explicitly so the result does not depend on the session time zone
    (date_trunc('day', (ts at time zone 'UTC') - interval '12 hours') + interval '12 hours') at time zone 'UTC' as window_start,
    ts, open, high, low, close
  from public.btc_spot_1h
)
select
  window_start,
  window_start + interval '1 day'                                   as window_end,
  extract(isodow from (window_start + interval '1 day') at time zone 'UTC')::int as end_isodow,  -- 1=Mon .. 7=Sun
  (array_agg(open  order by ts asc))[1]                             as open,
  max(high)                                                         as high,
  min(low)                                                          as low,
  (array_agg(close order by ts desc))[1]                            as close,
  max(high) - min(low)                                              as range_pts,
  (max(high) - min(low)) / nullif((array_agg(open order by ts asc))[1], 0) * 100 as range_pct,
  abs((array_agg(close order by ts desc))[1] - (array_agg(open order by ts asc))[1]) as abs_move_pts,
  count(*)                                                          as candles
from w
group by window_start
having count(*) = 24;

-- Average hourly range by IST hour, split weekday / weekend (by IST date).
create or replace view public.btc_hourly_activity with (security_invoker = on) as
select
  extract(hour from (ts at time zone 'Asia/Kolkata'))::int          as ist_hour,
  (extract(isodow from (ts at time zone 'Asia/Kolkata')) >= 6)      as is_weekend,
  count(*)                                                          as candles,
  avg((high - low) / nullif(open, 0) * 100)                         as avg_range_pct,
  avg(high - low)                                                   as avg_range_pts,
  avg(volume)                                                       as avg_volume
from public.btc_spot_1h
group by 1, 2;

-- One row per expiry: what the data covers.
create or replace view public.v_data_coverage with (security_invoker = on) as
select
  (select min(ts) from public.btc_spot_1h)            as spot_from,
  (select max(ts) from public.btc_spot_1h)            as spot_to,
  (select count(*) from public.btc_spot_1h)           as spot_rows,
  (select min(expiry_ts) from public.option_contracts) as first_expiry,
  (select max(expiry_ts) from public.option_contracts) as last_expiry,
  (select count(*) from public.option_contracts)      as contracts,
  (select count(*) from public.option_candles_1h)     as option_candles;

revoke all on public.v_option_candles, public.btc_daily_530, public.btc_hourly_activity, public.v_data_coverage from anon, authenticated;
grant select on public.v_option_candles, public.btc_daily_530, public.btc_hourly_activity, public.v_data_coverage to anon, authenticated;
