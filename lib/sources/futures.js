// Perpetual futures funding and open interest from other major venues.
// Funding rates are fractions per funding interval as each venue reports them (normally 8 hours).
import { getJson, SourceError, num, toMs } from '../http.js';

export async function fetchBinanceFutures() {
  const [p, o] = await Promise.all([
    getJson('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT'),
    getJson('https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT'),
  ]);
  const mark = num(p.json?.markPrice);
  if (mark === null) throw new SourceError('no mark price in response');
  return {
    data: {
      mark,
      index: num(p.json?.indexPrice),
      fundingRate: num(p.json?.lastFundingRate),
      nextFundingTs: toMs(p.json?.nextFundingTime),
      oiBtc: num(o.json?.openInterest),
    },
    exchangeTs: toMs(p.json?.time),
    latencyMs: Math.max(p.latencyMs, o.latencyMs),
    sample: JSON.stringify(p.json).slice(0, 500),
  };
}

export async function fetchBybitFutures() {
  const { json, latencyMs } = await getJson('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT');
  const r = json?.result?.list?.[0];
  if (!r) throw new SourceError('unexpected response shape');
  return {
    data: {
      mark: num(r.markPrice),
      index: num(r.indexPrice),
      fundingRate: num(r.fundingRate),
      nextFundingTs: toMs(r.nextFundingTime),
      oiBtc: num(r.openInterest),
    },
    exchangeTs: toMs(json?.time),
    latencyMs,
    sample: JSON.stringify(r).slice(0, 500),
  };
}

export async function fetchOkxFutures() {
  const [f, o, m] = await Promise.all([
    getJson('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP'),
    getJson('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP'),
    getJson('https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=BTC-USDT-SWAP'),
  ]);
  const fr = f.json?.data?.[0];
  if (!fr) throw new SourceError('unexpected response shape');
  return {
    data: {
      mark: num(m.json?.data?.[0]?.markPx),
      index: null,
      fundingRate: num(fr.fundingRate),
      nextFundingTs: toMs(fr.nextFundingTime),
      oiBtc: num(o.json?.data?.[0]?.oiCcy),
    },
    exchangeTs: toMs(o.json?.data?.[0]?.ts),
    latencyMs: Math.max(f.latencyMs, o.latencyMs, m.latencyMs),
    sample: JSON.stringify(fr).slice(0, 500),
  };
}
