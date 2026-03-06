const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use(cors({
  origin: 'http://localhost:3000',
  credentials: true
}));

app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});



// In-memory storage
const stockHistory = {};   // { SYMBOL: [ {...}, ... ] }
const activeJobs   = {};   // { SYMBOL: intervalId }

// ─── EDGE CASE: Missing API key ───────────────────────────────────────────────
// Problem: If FINNHUB_API_KEY is not set, every fetch silently uses the string
// "your_api_key_here", Finnhub returns 401, and the server just logs an error
// forever. We catch this at startup so you know immediately instead of
// wondering why no data ever arrives.
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
if (!FINNHUB_API_KEY) {
  console.error('FATAL: FINNHUB_API_KEY environment variable is not set.');
  console.error('Copy .env.example to .env and add your Finnhub API key, then restart.');
  process.exit(1);
}

const BASE_URL = 'https://finnhub.io/api/v1';

// ─── EDGE CASE: Network timeout ───────────────────────────────────────────────
// Problem: Node's built-in fetch() waits forever if Finnhub doesn't respond.
// In a setInterval job this is catastrophic — the interval fires again while
// the previous fetch is still hanging, eventually piling up dozens of stuck
// requests and exhausting memory/sockets. We abort after 8 seconds.
const FETCH_TIMEOUT_MS = 8_000;

// ─── EDGE CASE: Finnhub rate limiting ────────────────────────────────────────
// Problem: Finnhub's free tier allows 60 API calls per minute across ALL symbols.
// If you monitor 10 symbols every 5 seconds that's 120 calls/min — you'll hit
// 429 Too Many Requests. We track calls in a rolling 60-second window and
// reject new fetches (with a clear error) before they even hit Finnhub.
const MAX_CALLS_PER_MINUTE = 55; // stay just under the 60 limit for safety
const callTimestamps = [];        // timestamps of recent API calls

function checkRateLimit() {
  const now = Date.now();
  while (callTimestamps.length && callTimestamps[0] < now - 60_000) {
    callTimestamps.shift();
  }
  if (callTimestamps.length >= MAX_CALLS_PER_MINUTE) {
    const retryAfterMs = 60_000 - (now - callTimestamps[0]);
    throw new Error(
      `Local rate limit reached (${MAX_CALLS_PER_MINUTE} calls/min). ` +
      `Retry in ${Math.ceil(retryAfterMs / 1000)}s.`
    );
  }
  callTimestamps.push(now);
}

// ─── EDGE CASE: Concurrency guard ────────────────────────────────────────────
// Problem: POST /start-monitoring is async. If the same symbol is posted twice
// in rapid succession, both requests pass the "is there an active job?" check
// before either has finished the initial fetch — spawning two intervals for
// the same symbol. We block the second request with a Set of in-progress symbols.
const initializingSymbols = new Set();

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchStockData(symbol) {
  checkRateLimit();

  const url = `${BASE_URL}/quote?symbol=${symbol.toUpperCase()}&token=${FINNHUB_API_KEY}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Finnhub request timed out after ${FETCH_TIMEOUT_MS / 1000}s.`);
    }
    throw new Error(`Network error: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    throw new Error('Finnhub rejected the API key (401). Check your FINNHUB_API_KEY.');
  }
  if (res.status === 429) {
    throw new Error('Finnhub rate limit hit (429). Reduce your monitoring frequency.');
  }
  if (!res.ok) {
    throw new Error(`Finnhub responded with status ${res.status}.`);
  }

  // ─── EDGE CASE: Malformed / partial JSON ───────────────────────────────────
  // If Finnhub returns an unexpected payload (HTML error page, empty body),
  // res.json() throws. Wrap it so the interval job doesn't crash the process.
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Finnhub returned a non-JSON response. Try again shortly.');
  }

  if (data.c === 0 && data.o === 0) {
    throw new Error(`No data for "${symbol}". Verify it is a valid ticker symbol.`);
  }

  return {
    symbol:        symbol.toUpperCase(),
    open:          data.o,
    high:          data.h,
    low:           data.l,
    current:       data.c,
    previousClose: data.pc,
    timestamp:     new Date().toISOString(),
  };
}

function appendHistory(symbol, record) {
  const key = symbol.toUpperCase();
  if (!stockHistory[key]) stockHistory[key] = [];
  stockHistory[key].push(record);
}

// ─── EDGE CASE: Whitespace-only symbol & non-string types ────────────────────
// typeof null === 'object', typeof 123 === 'number' — both would slip past a
// naive check. "   ".trim().length is 0 so whitespace-only is also caught.
// Cap at 10 chars; real tickers max out at 5 (e.g. "BRK.B").
function validateSymbol(symbol) {
  return (
    typeof symbol === 'string' &&
    symbol.trim().length > 0 &&
    symbol.trim().length <= 10
  );
}

// ─── EDGE CASE: minutes=0, seconds=0 & float values & huge intervals ─────────
// minutes=0, seconds=0 → intervalMs=0 → setInterval fires as fast as possible,
// effectively DoS-ing Finnhub and your own server.
// Float values like 1.5 fail Number.isInteger(), which is correct behaviour.
// We also cap at 24 hours so someone can't accidentally set a 999999-minute poll.
const MAX_INTERVAL_MINUTES = 24 * 60;

function validateInterval(minutes, seconds) {
  const m = Number(minutes ?? 0);
  const s = Number(seconds ?? 0);
  return (
    Number.isInteger(m) && m >= 0 &&
    Number.isInteger(s) && s >= 0 &&
    (m + s) > 0 &&
    (m + s / 60) <= MAX_INTERVAL_MINUTES
  );
}

// ─── POST /start-monitoring ──────────────────────────────────────────────────

app.post('/start-monitoring', async (req, res) => {
  const { symbol, minutes = 0, seconds = 0 } = req.body;

  if (!validateSymbol(symbol)) {
    return res.status(400).json({
      error: '`symbol` must be a non-empty string of 1–10 characters.',
    });
  }
  if (!validateInterval(minutes, seconds)) {
    return res.status(400).json({
      error:
        '`minutes` and `seconds` must be non-negative integers whose sum is ' +
        `between 1 second and ${MAX_INTERVAL_MINUTES} minutes.`,
    });
  }

  const key = symbol.trim().toUpperCase();

  // ─── EDGE CASE: Concurrency — same symbol posted twice rapidly ─────────────
  if (initializingSymbols.has(key)) {
    return res.status(409).json({
      error: `${key} is already being initialized. Please wait a moment.`,
    });
  }

  const intervalMs = (Number(minutes) * 60 + Number(seconds)) * 1000;

  // ─── EDGE CASE: Same symbol already running (your fix) ───────────────────
  // Without this, calling /start-monitoring twice stacks a second setInterval
  // on top of the first — doubling API calls and history writes every tick.
  if (activeJobs[key]) {
    clearInterval(activeJobs[key]);
    delete activeJobs[key];
    console.log(`[${new Date().toISOString()}] Reset monitoring for ${key}, new interval: ${intervalMs}ms.`);
  }

  initializingSymbols.add(key);

  try {
    const record = await fetchStockData(key);
    appendHistory(key, record);
  } catch (err) {
    initializingSymbols.delete(key);
    return res.status(502).json({ error: `Failed to fetch initial data: ${err.message}` });
  }

  activeJobs[key] = setInterval(async () => {
    try {
      const record = await fetchStockData(key);
      appendHistory(key, record);
      console.log(`[${new Date().toISOString()}] Updated ${key}: $${record.current}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error fetching ${key}: ${err.message}`);
    }
  }, intervalMs);

  initializingSymbols.delete(key);

  return res.status(200).json({
    message: `Monitoring started for ${key}.`,
    symbol: key,
    intervalMs,
  });
});

// ─── GET /history ─────────────────────────────────────────────────────────────

app.get('/history', (req, res) => {
  const { symbol } = req.query;

  if (!validateSymbol(symbol)) {
    return res.status(400).json({ error: '`symbol` query parameter is required.' });
  }

  const key = symbol.trim().toUpperCase();

  // ─── EDGE CASE: History for unmonitored symbol ────────────────────────────
  // Return 404 instead of an empty array so the caller knows the symbol was
  // never tracked, rather than thinking "monitoring started but no data yet".
  if (!stockHistory[key]) {
    return res.status(404).json({
      error: `No history found for ${key}. Start monitoring it first.`,
    });
  }

  return res.status(200).json({
    symbol: key,
    count: stockHistory[key].length,
    history: stockHistory[key],
  });
});

// ─── POST /refresh (bonus) ────────────────────────────────────────────────────

app.post('/refresh', async (req, res) => {
  const { symbol } = req.body;

  if (!validateSymbol(symbol)) {
    return res.status(400).json({ error: '`symbol` must be a non-empty string.' });
  }

  const key = symbol.trim().toUpperCase();

  try {
    const record = await fetchStockData(key);
    appendHistory(key, record);
    return res.status(200).json({ message: 'Refreshed successfully.', record });
  } catch (err) {
    return res.status(502).json({ error: `Failed to fetch data: ${err.message}` });
  }
});

// ─── POST /stop-monitoring (bonus) ───────────────────────────────────────────

app.post('/stop-monitoring', (req, res) => {
  const { symbol } = req.body;

  if (!validateSymbol(symbol)) {
    return res.status(400).json({ error: '`symbol` must be a non-empty string.' });
  }

  const key = symbol.trim().toUpperCase();

  if (!activeJobs[key]) {
    // ─── EDGE CASE: Stop on symbol with history but no active job ────────────
    // Give a more helpful message than a generic 404 — the history is still there.
    if (stockHistory[key]) {
      return res.status(409).json({
        error: `${key} is not currently being monitored, but its history is still available via GET /history.`,
      });
    }
    return res.status(404).json({ error: `No active monitoring job found for ${key}.` });
  }

  clearInterval(activeJobs[key]);
  delete activeJobs[key];

  return res.status(200).json({ message: `Monitoring stopped for ${key}.` });
});

// ─── GET /status (bonus) ──────────────────────────────────────────────────────

app.get('/status', (req, res) => {
  const now = Date.now();
  const recentCalls = callTimestamps.filter(t => t > now - 60_000).length;

  return res.status(200).json({
    monitored: Object.keys(activeJobs),
    tracked: Object.keys(stockHistory).map(sym => ({
      symbol: sym,
      records: stockHistory[sym].length,
      isMonitoring: !!activeJobs[sym],
    })),
    rateLimit: {
      callsInLastMinute: recentCalls,
      limitPerMinute: MAX_CALLS_PER_MINUTE,
      remaining: Math.max(0, MAX_CALLS_PER_MINUTE - recentCalls),
    },
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Stock Exchange API running on http://localhost:${PORT}`);
  console.log('Endpoints:');
  console.log('  POST /start-monitoring  — begin polling a stock symbol');
  console.log('  GET  /history?symbol=   — retrieve stored history');
  console.log('  POST /refresh           — immediate one-time fetch');
  console.log('  POST /stop-monitoring   — stop polling a symbol');
  console.log('  GET  /status            — list all symbols + rate limit usage');
});