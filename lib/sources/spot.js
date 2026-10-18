// Spot BTC price from several independent venues, used to cross-check Delta's index.
// USDT-quoted venues are labelled; the small USD/USDT difference is shown, not hidden.
import { getJson, SourceError, num, toMs } from '../http.js';

export const SPOT_VENUES = [
  {
    name: 'Coinbase',
    quote: 'USD',
    url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
    parse: (j) => ({ price: num(j?.price), ts: j?.time ? Date.parse(j.time) : null }),
  },
  {
    name: 'Kraken',
    quote: 'USD',
    url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
    parse: (j) => {
      const r = Object.values(j?.result ?? {})[0];
      return { price: num(r?.c?.[0]), ts: null };
    },
  },
  {
    name: 'Bitstamp',
    quote: 'USD',
    url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/',
    parse: (j) => ({ price: num(j?.last), ts: toMs(j?.timestamp) }),
  },
  {
    name: 'Binance',
    quote: 'USDT',
    url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
    parse: (j) => ({ price: num(j?.price), ts: null }),
  },
  {
    name: 'OKX',
    quote: 'USDT',
    url: 'https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT',
    parse: (j) => ({ price: num(j?.data?.[0]?.last), ts: toMs(j?.data?.[0]?.ts) }),
  },
];

export async function fetchSpot(venue) {
  const { json, latencyMs } = await getJson(venue.url, { timeoutMs: 5000 });
  const { price, ts } = venue.parse(json);
  if (price === null || price < 1000) throw new SourceError('no valid price in response');
  return {
    data: { venue: venue.name, quote: venue.quote, price, hasExchangeTs: ts !== null },
    exchangeTs: ts,
    latencyMs,
    sample: JSON.stringify(json).slice(0, 400),
  };
}
