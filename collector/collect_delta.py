#!/usr/bin/env python3
"""
Incremental Delta Exchange India BTC download for the daily GitHub Action.
Public data only. Writes the same 3 CSV files the Colab downloader makes, but only for what is new:
  btc_spot_1h.csv, btc_options_products.csv, btc_options_1h.csv   (in --out)

It only writes a whole expiry day or nothing, and stops at the first day with a failed download,
so the next run picks that day up again. Exit code 1 means "some data is still missing".
No third-party packages needed.
"""
import argparse, csv, json, os, sys, time
import urllib.error, urllib.parse, urllib.request
from collections import OrderedDict
from datetime import datetime, timedelta, timezone

BASE = os.environ.get("DELTA_BASE", "https://api.india.delta.exchange")
HEADERS = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
IST = timezone(timedelta(hours=5, minutes=30))
STRIKE_RANGE = 3000  # same filter as the historical download: strikes within 3000 of spot


def api_get(path, params, tries=8):
    url = BASE + path + "?" + urllib.parse.urlencode(params)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(min(60, 10 * (i + 1)))
                continue
            if e.code in (400, 404):
                return {"success": False, "result": []}
            print(f"   HTTP {e.code} for {path}", flush=True)
            if e.code in (401, 403, 451):  # blocked: retrying will not help
                return None
            time.sleep(2 * (i + 1))
        except Exception as e:  # network error
            print(f"   {type(e).__name__} for {path}", flush=True)
            time.sleep(2 * (i + 1))
    return None


def get_candles(symbol, start, end, resolution="1h"):
    step, rows, t = 3600 * 1900, {}, start
    while t < end:
        e = min(t + step, end)
        d = api_get("/v2/history/candles", {"resolution": resolution, "symbol": symbol, "start": t, "end": e})
        if d is None:
            raise RuntimeError(f"candle download failed for {symbol}")
        for c in d.get("result") or []:
            rows[int(c["time"])] = c
        t = e
        time.sleep(0.03)
    return [rows[k] for k in sorted(rows)]


def fmt_utc(t): return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d %H:%M")
def fmt_ist(t): return datetime.fromtimestamp(t, IST).strftime("%Y-%m-%d %H:%M")


def list_new_products(after_expiry_ts, now_ts):
    found, cursor, idle, page = {}, None, 0, 0
    while True:
        params = {"contract_types": "call_options,put_options", "states": "expired,live", "page_size": 500}
        if cursor:
            params["after"] = cursor
        d = api_get("/v2/products", params)
        if d is None:
            raise RuntimeError("could not list contracts")
        result = d.get("result") or []
        page += 1
        before = len(found)
        for x in result:
            sym = x.get("symbol", "")
            und = (x.get("underlying_asset") or {}).get("symbol", "")
            if und != "BTC" and "-BTC-" not in sym:
                continue
            st = x.get("settlement_time")
            if not st or x.get("strike_price") is None:
                continue
            settle = int(datetime.fromisoformat(st.replace("Z", "+00:00")).timestamp())
            if not (after_expiry_ts < settle <= now_ts):
                continue
            found[sym] = {"symbol": sym, "type": "call" if x.get("contract_type") == "call_options" else "put",
                          "strike": float(x["strike_price"]), "expiry_ts": settle, "expiry_utc": fmt_utc(settle)}
        idle = idle + 1 if len(found) == before else 0
        if found and idle >= 30:
            break
        cursor = (d.get("meta") or {}).get("after")
        if not cursor or not result:
            break
        time.sleep(0.2)
    print(f"   listed {page} pages, {len(found)} new expired contracts", flush=True)
    return sorted(found.values(), key=lambda p: (p["expiry_ts"], p["type"], p["strike"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--last-spot-ts", type=int, required=True, help="newest spot candle already stored (epoch s)")
    ap.add_argument("--last-expiry-ts", type=int, required=True, help="newest option expiry already stored (epoch s)")
    a = ap.parse_args()
    if a.last_spot_ts <= 0 or a.last_expiry_ts <= 0:
        sys.exit("The database is empty. Load the history first with the Colab notebook (supabase/load).")
    os.makedirs(a.out, exist_ok=True)
    now = int(time.time())

    # 1) spot: re-fetch the last hours (the newest stored candle may have been unfinished) and enough
    #    history to know the spot price 24h before each new expiry
    start = min(a.last_spot_ts - 3 * 3600, a.last_expiry_ts - 26 * 3600)
    print(f"1/3 spot from {fmt_utc(start)} UTC", flush=True)
    spot = get_candles("BTCUSD", start, now) or get_candles(".DEXBTUSD", start, now)
    if not spot:
        sys.exit("No BTC spot data returned.")
    with open(os.path.join(a.out, "btc_spot_1h.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["time_utc", "time_ist", "open", "high", "low", "close", "volume"])
        for c in spot:
            t = int(c["time"])
            w.writerow([fmt_utc(t), fmt_ist(t), c["open"], c["high"], c["low"], c["close"], c.get("volume", "")])
    spot_open = {int(c["time"]): float(c["open"]) for c in spot}
    print(f"   {len(spot)} spot candles", flush=True)

    # 2) new expired contracts, near the money like the history
    print("2/3 new option contracts", flush=True)
    keep = []
    for p in list_new_products(a.last_expiry_ts, now):
        ref = p["expiry_ts"] - 24 * 3600
        s = spot_open.get(ref - ref % 3600)
        if s is not None and abs(p["strike"] - s) <= STRIKE_RANGE:
            p["spot_day_before"] = s
            keep.append(p)
    by_day = OrderedDict()
    for p in keep:
        by_day.setdefault(p["expiry_ts"], []).append(p)

    # 3) candles, whole days only, oldest first, stop at the first failure
    print(f"3/3 option candles for {len(keep)} contracts on {len(by_day)} expiry days", flush=True)
    prods, rows_out, complete_days, failed = [], [], 0, False
    for exp, plist in by_day.items():
        day_rows = []
        try:
            for p in plist:
                e, st = p["expiry_ts"], p["expiry_ts"] - 25 * 3600
                rows, source = get_candles("MARK:" + p["symbol"], st, e), "mark"
                if not rows:
                    rows, source = get_candles(p["symbol"], st, e), "trades"
                for c in rows:
                    t = int(c["time"])
                    day_rows.append([p["symbol"], p["type"], p["strike"], p["expiry_utc"], fmt_utc(t), fmt_ist(t),
                                     round((e - t) / 3600, 2), c["open"], c["high"], c["low"], c["close"], c.get("volume", ""), source])
        except RuntimeError as err:
            print(f"   ! {fmt_utc(exp)} UTC incomplete ({err}); it will be retried next run", flush=True)
            failed = True
            break
        prods += plist
        rows_out += day_rows
        complete_days += 1
        print(f"   {fmt_utc(exp)} UTC ok: {len(plist)} contracts, {len(day_rows)} candles", flush=True)

    with open(os.path.join(a.out, "btc_options_products.csv"), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["symbol", "type", "strike", "expiry_utc", "expiry_ts", "spot_day_before"], extrasaction="ignore")
        w.writeheader()
        w.writerows(prods)
    with open(os.path.join(a.out, "btc_options_1h.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["symbol", "type", "strike", "expiry_utc", "time_utc", "time_ist", "hours_to_expiry", "open", "high", "low", "close", "volume", "source"])
        w.writerows(rows_out)
    print(f"done: {complete_days} expiry days, {len(prods)} contracts, {len(rows_out)} candles", flush=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
