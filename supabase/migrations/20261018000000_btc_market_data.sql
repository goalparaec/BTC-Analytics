-- BTC market data: hourly spot, Delta option contracts, Delta option hourly candles.
-- All timestamps are stored as timestamptz (UTC). IST is derived in views.
-- Public market data only: anyone with the anon/publishable key can read, nobody but the
-- service role / postgres user can write.

create table if not exists public.btc_spot_1h (
  ts      timestamptz primary key,          -- candle open time (UTC)
  open    numeric(14,2) not null,
  high    numeric(14,2) not null,
  low     numeric(14,2) not null,
  close   numeric(14,2) not null,
  volume  numeric(24,4),
  check (high >= low)
);
comment on table public.btc_spot_1h is 'BTC hourly spot candles (Delta BTCUSD). ts is the candle open in UTC.';

create table if not exists public.option_contracts (
  symbol           text primary key,        -- e.g. C-BTC-83200-181026
  option_type      text not null check (option_type in ('call','put')),
  strike           numeric(12,2) not null,
  expiry_ts        timestamptz not null,    -- Delta daily options expire 12:00 UTC (5:30 PM IST)
  spot_day_before  numeric(14,2)            -- BTC spot noted by the downloader the day before expiry
);
comment on table public.option_contracts is 'Delta Exchange India BTC option contracts, one row per symbol.';
create index if not exists option_contracts_expiry_idx on public.option_contracts (expiry_ts, option_type, strike);

create table if not exists public.option_candles_1h (
  symbol  text not null references public.option_contracts (symbol) on delete cascade,
  ts      timestamptz not null,             -- candle open time (UTC)
  open    numeric(16,6) not null,
  high    numeric(16,6) not null,
  low     numeric(16,6) not null,
  close   numeric(16,6) not null,
  volume  numeric(24,4),
  kind    text not null default 'mark' check (kind in ('mark','trade')),  -- mark = mark-price candles, not executable prices
  primary key (symbol, ts),
  check (high >= low)
);
comment on table public.option_candles_1h is 'Hourly candles per option contract. kind=mark means mark price (not a traded price).';
create index if not exists option_candles_ts_idx on public.option_candles_1h (ts);

-- Read-only public access through row level security.
alter table public.btc_spot_1h       enable row level security;
alter table public.option_contracts  enable row level security;
alter table public.option_candles_1h enable row level security;

drop policy if exists "public read" on public.btc_spot_1h;
drop policy if exists "public read" on public.option_contracts;
drop policy if exists "public read" on public.option_candles_1h;
create policy "public read" on public.btc_spot_1h       for select to anon, authenticated using (true);
create policy "public read" on public.option_contracts  for select to anon, authenticated using (true);
create policy "public read" on public.option_candles_1h for select to anon, authenticated using (true);

revoke all on public.btc_spot_1h, public.option_contracts, public.option_candles_1h from anon, authenticated;
grant select on public.btc_spot_1h, public.option_contracts, public.option_candles_1h to anon, authenticated;
