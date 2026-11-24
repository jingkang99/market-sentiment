#!/usr/bin/env node
/**
 * candlestick.js — ZERO DEPENDENCIES
 *
 * Pulls ~6 months of daily OHLCV data from Yahoo Finance using only Node's
 * built-in `https`, `zlib`, `fs`, `path`, `os`. Saves to <SYMBOL>_<DATE>.csv
 * and renders an ANSI candlestick chart in the Linux terminal.
 */

'use strict';

const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

// =========================================================================
// Configuration
// =========================================================================
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];

const CACHE_DIR = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
  'candlestick-cli'
);
const DATA_TTL        = 5  * 60 * 1000;
const RETRY_TTL       = 30 * 1000;
const SYMBOL_DELAY_MS = 800;

// =========================================================================
// ANSI
// =========================================================================
const RESET    = '\x1b[0m';
const BOLD     = '\x1b[1m';
const DIM      = '\x1b[90m';
const GREEN    = '\x1b[32m';
const RED      = '\x1b[31m';
const CYAN     = '\x1b[36m';
const YELL     = '\x1b[33m';
const MAGENTA  = '\x1b[35m';
const CLR_LINE = '\x1b[2K\r';

const GAP_STYLES = {
  '0':        '',
  'none':     '',
  'compact':  '',
  'dot':      `${DIM}·${RESET}`,
  'hairline': `${DIM}┊${RESET}`,
  '1':        ' ',
  'space':    ' ',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 23);

let VERBOSE = false;
function vlog(msg) {
  if (VERBOSE) console.error(`${DIM}[${ts()}]${RESET} ${msg}`);
}

function nextArgValue(argList, idx, flagName) {
  if (idx + 1 >= argList.length) {
    throw new Error(`Missing value after ${flagName}`);
  }
  return argList[idx + 1];
}

// =========================================================================
// CLI parsing
// =========================================================================
const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '-h' || args[0] === '--help') {
  console.log('Usage: node candlestick.js [options] <SYM> [SYM2 SYM3 ...]');
  console.log();
  console.log('Options:');
  console.log('  -v, --verbose            log every HTTP request to stderr');
  console.log('  --height <n|auto>        chart height in terminal rows (default: auto)');
  console.log('  --width  <n|auto>        candles shown (default: auto-fit latest to terminal)');
  console.log('  --gap <0|1|dot|hairline> gap between candles (default: 50)');
  console.log('  --no-chart               skip terminal rendering');
  console.log('  --no-cache               ignore CSV + JSON cache (force fresh fetch)');
  console.log('  --no-csv                 do not write CSV file');
  console.log('  --out-dir <dir>          directory to write CSV files (default: current dir)');
  console.log();
  console.log('Examples:');
  console.log('  node candlestick.js AAPL');
  console.log('  node candlestick.js AAPL --gap 0        # maximum bars in terminal width');
  console.log('  node candlestick.js AAPL --gap 1        # wide space gap between bars');
  console.log('  node candlestick.js AAPL --gap hairline # faint vertical hairline separator');
  process.exit(args.length === 0 ? 1 : 0);
}

const opts = {
  height: null,
  width: null,
  gap: '1',
  drawChart: true,
  useCache: true,
  writeCsv: true,
  outDir: process.cwd(),
};
const symbols = [];

try {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-v' || a === '--verbose') {
      VERBOSE = true;
    } else if (a === '--height') {
      const v = nextArgValue(args, i, '--height');
      i++;
      const parsed = parseInt(v, 10);
      opts.height = (v === 'auto' || Number.isNaN(parsed) || parsed <= 0) ? null : parsed;
    } else if (a === '--width') {
      const v = nextArgValue(args, i, '--width');
      i++;
      const parsed = parseInt(v, 10);
      opts.width = (v === 'auto' || Number.isNaN(parsed) || parsed <= 0) ? null : parsed;
    } else if (a === '--gap') {
      const g = nextArgValue(args, i, '--gap').toLowerCase();
      i++;
      if (!Object.prototype.hasOwnProperty.call(GAP_STYLES, g)) {
        throw new Error(`Invalid --gap "${g}". Use one of: 0, 1, dot, hairline`);
      }
      opts.gap = g;
    } else if (a === '--no-chart') {
      opts.drawChart = false;
    } else if (a === '--no-cache') {
      opts.useCache = false;
    } else if (a === '--no-csv') {
      opts.writeCsv = false;
    } else if (a === '--out-dir') {
      opts.outDir = nextArgValue(args, i, '--out-dir');
      i++;
    } else if (a.startsWith('-')) {
      vlog(`${YELL}[cli]${RESET} unknown flag: ${a}`);
    } else {
      symbols.push(a.toUpperCase());
    }
  }
} catch (err) {
  console.error(`${RED}Error:${RESET} ${err.message}`);
  process.exit(1);
}

if (symbols.length === 0) {
  console.error('No symbols provided.');
  process.exit(1);
}

function getGapConfig(gapName) {
  const rendered = GAP_STYLES[gapName] ?? GAP_STYLES.dot;
  const colsPerGap = rendered.length === 0 ? 0 : 1;
  return { rendered, colsPerGap };
}

// =========================================================================
// CSV cache (today's date-stamped file)
// =========================================================================
function todayString() {
  return new Date().toISOString().slice(0, 10);
}
function csvPathFor(symbol, date, outDir) {
  return path.join(outDir, `${symbol}_${date}.csv`);
}
function legacyCsvPathFor(symbol, outDir) {
  return path.join(outDir, `${symbol}_6mo.csv`);
}
function tryLoadCsv(symbol, outDir) {
  const dateFile = csvPathFor(symbol, todayString(), outDir);
  const legacyFile = legacyCsvPathFor(symbol, outDir);
  for (const [label, filename] of [['date-stamped', dateFile], ['legacy', legacyFile]]) {
    if (!fs.existsSync(filename)) continue;
    try {
      const text = fs.readFileSync(filename, 'utf8').trim();
      if (!text) continue;
      const lines = text.split(/\r?\n/);
      if (lines.length < 2) continue;
      const start = /^Date,/i.test(lines[0]) ? 1 : 0;
      const rows = [];
      for (let i = start; i < lines.length; i++) {
        const parts = lines[i].split(',');
        if (parts.length < 5) continue;
        const date = parts[0];
        const open = +parts[1], high = +parts[2], low = +parts[3], close = +parts[4];
        const vol  = parts.length >= 6 ? +parts[5] : 0;
        if (!date || !isFinite(open) || !isFinite(high) || !isFinite(low) || !isFinite(close)) continue;
        rows.push({ date, open, high, low, close, volume: isFinite(vol) ? vol : 0 });
      }
      if (rows.length < 20) {
        vlog(`${YELL}[csv]${RESET} ${filename} only has ${rows.length} rows, ignoring`);
        continue;
      }
      rows.sort((a, b) => a.date.localeCompare(b.date));
      vlog(`${GREEN}[csv]${RESET} using ${label} ${DIM}${filename}${RESET} (${rows.length} rows)`);
      return rows;
    } catch (e) {
      vlog(`${YELL}[csv]${RESET} failed to parse ${filename}: ${e.message}`);
    }
  }
  return null;
}

// =========================================================================
// JSON disk cache (transient)
// =========================================================================
function cacheGet(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j._cachedAt || !j._ttl || Date.now() - j._cachedAt > j._ttl) return null;
    return j;
  } catch { return null; }
}
function cachePut(file, payload, ttl) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...payload, _cachedAt: Date.now(), _ttl: ttl }));
  } catch { /* non-fatal */ }
}

// =========================================================================
// Auto-detect terminal dimensions
// =========================================================================
function autoDetectWidth(totalRows, colsPerGap = 1) {
  const cols = process.stdout.columns || 120;
  const LABEL_W = 10;
  const SPINE_W = 1;
  const RIGHT_MARGIN = 2;
  const availCols = Math.max(10, cols - LABEL_W - SPINE_W - RIGHT_MARGIN);

  // Span for N candles = N + (N - 1) * colsPerGap = N * (1 + colsPerGap) - colsPerGap
  const stride = 1 + colsPerGap;
  const maxFittingCandles = Math.max(1, Math.floor((availCols + colsPerGap) / stride));

  return typeof totalRows === 'number' && totalRows > 0
    ? Math.min(totalRows, maxFittingCandles)
    : maxFittingCandles;
}

function autoDetectHeight(data) {
  const TERM_ROWS = process.stdout.rows || 32;
  const MAX_H = Math.max(16, Math.min(70, TERM_ROWS - 12));
  const MIN_H = 16;

  if (!data || data.length === 0) return 26;

  const maxP = Math.max(...data.map(d => d.high));
  const minP = Math.min(...data.map(d => d.low));
  const range = maxP - minP;
  if (!isFinite(range) || range <= 0) return 24;

  const typicalRanges = data
    .map(d => d.high - d.low)
    .filter(r => r > 0)
    .sort((a, b) => a - b);

  if (typicalRanges.length === 0) return 26;

  const p25 = typicalRanges[Math.floor(typicalRanges.length * 0.25)];
  const desiredHalfRows = Math.ceil((2.2 * range) / p25);
  const height = Math.ceil(desiredHalfRows / 2);

  return Math.max(MIN_H, Math.min(MAX_H, height));
}

// =========================================================================
// HTTP client
// =========================================================================
function httpsGet(rawUrl, extraHeaders = {}, redirectsLeft = 5) {
  const url = new URL(rawUrl);
  const headers = {
    'User-Agent':      USER_AGENT,
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept':          'application/json,text/plain,*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    ...extraHeaders,
  };

  if (VERBOSE) {
    vlog(`${MAGENTA}HTTP${RESET} ${CYAN}→${RESET} ${DIM}GET${RESET} ${url.hostname}${url.pathname}${url.search}`);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: url.hostname, path: url.pathname + url.search, method: 'GET', headers },
      (res) => {
        if (VERBOSE) {
          const cl = res.headers['content-length'];
          const ce = res.headers['content-encoding'] || 'identity';
          const color = res.statusCode === 200 ? GREEN : res.statusCode >= 400 ? RED : YELL;
          vlog(`${MAGENTA}HTTP${RESET} ${color}←${RESET} ${res.statusCode} ${DIM}${res.headers['content-type'] || ''} ${ce}${cl ? ' ' + cl + 'B' : ''}${RESET}`);
        }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${url.protocol}//${url.host}${res.headers.location}`;
          resolve(httpsGet(next, extraHeaders, redirectsLeft - 1));
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const raw = Buffer.concat(chunks);
            const enc = (res.headers['content-encoding'] || '').toLowerCase();
            let buf;
            if      (enc === 'gzip')    buf = zlib.gunzipSync(raw);
            else if (enc === 'deflate') buf = zlib.inflateSync(raw);
            else if (enc === 'br')      buf = zlib.brotliDecompressSync(raw);
            else                        buf = raw;
            resolve({ statusCode: res.statusCode, headers: res.headers, body: buf.toString('utf8') });
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Request timeout')));
    req.end();
  });
}

// =========================================================================
// Historical data from Yahoo
// =========================================================================
function isJson(body) {
  const t = body.trimStart();
  return t.startsWith('{') || t.startsWith('[');
}

async function fetchHistorical(symbol) {
  const now  = Math.floor(Date.now() / 1000);
  const past = now - 6 * 30 * 24 * 60 * 60;

  const cacheKey = `${symbol}_${past}_${now}`;
  const dataFile = path.join(CACHE_DIR, `data_${symbol}_${cacheKey}.json`);

  if (opts.useCache) {
    const hit = cacheGet(dataFile);
    if (hit && hit.rows) {
      vlog(`${GREEN}[cache]${RESET} hit ${DIM}${dataFile}${RESET} (${hit.rows.length} rows)`);
      return hit.rows;
    }
    if (hit && hit._negative) {
      throw new Error('429 Too Many Requests (cached cooldown active)');
    }
    vlog(`${YELL}[cache]${RESET} miss ${DIM}${dataFile}${RESET}`);
  }

  const buildUrl = (host) => {
    const p = new URLSearchParams({
      period1: String(past),
      period2: String(now),
      interval: '1d',
      events: 'history',
      includeAdjustedClose: 'true',
    });
    return `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${p.toString()}`;
  };

  let hostIdx = 0;
  const nextHost = () => HOSTS[hostIdx++ % HOSTS.length];

  const MAX_TRIES = 6;
  let lastError = null;

  for (let attemptNo = 1; attemptNo <= MAX_TRIES; attemptNo++) {
    const host = nextHost();
    let res;
    try {
      res = await httpsGet(buildUrl(host));
    } catch (e) {
      lastError = e;
      const wait = 600 + Math.random() * 400;
      logRetry(`network error: ${e.message}`, wait / 1000, attemptNo, MAX_TRIES, host);
      await sleep(wait);
      continue;
    }

    if (res.statusCode === 200 && isJson(res.body)) {
      let data;
      try { data = JSON.parse(res.body); }
      catch (e) {
        lastError = new Error('JSON parse failed');
        logRetry('JSON parse failed', 1, attemptNo, MAX_TRIES, host);
        await sleep(1000);
        continue;
      }

      const err = data?.chart?.error;
      if (err && !data?.chart?.result?.[0]) {
        throw new Error(err.description || `Yahoo error: ${err.code || 'unknown'}`);
      }

      const result = data?.chart?.result?.[0];
      if (!result) {
        lastError = new Error('Empty chart result');
        logRetry('empty result', 1, attemptNo, MAX_TRIES, host);
        await sleep(1000);
        continue;
      }

      const tsArr = result.timestamp || [];
      const q     = result.indicators.quote[0];
      const rows  = [];
      for (let i = 0; i < tsArr.length; i++) {
        if (q.open[i] == null || q.high[i] == null ||
            q.low[i]  == null || q.close[i] == null) continue;
        rows.push({
          date:   new Date(tsArr[i] * 1000).toISOString().slice(0, 10),
          open:   Number(q.open[i]),
          high:   Number(q.high[i]),
          low:    Number(q.low[i]),
          close:  Number(q.close[i]),
          volume: Number(q.volume[i]) || 0,
        });
      }
      if (rows.length === 0) {
        throw new Error(`No usable OHLC rows for "${symbol}". The ticker may be invalid or delisted.`);
      }

      rows.sort((a, b) => a.date.localeCompare(b.date));

      cachePut(dataFile, { rows }, DATA_TTL);
      vlog(`${GREEN}[fetch]${RESET} ok ${rows.length} rows from ${DIM}${host}${RESET}`);
      return rows;
    }

    if (res.statusCode === 429) {
      cachePut(dataFile, { _negative: true }, RETRY_TTL);
      lastError = new Error('429 Too Many Requests');
      const retryAfter = parseInt(res.headers['retry-after'], 10);
      const wait = retryAfter
        ? retryAfter * 1000
        : Math.min(15_000, 1000 * Math.pow(2, attemptNo - 1)) + Math.floor(Math.random() * 400);
      logRetry('429 Too Many Requests', wait / 1000, attemptNo, MAX_TRIES, host);
      await sleep(Math.max(1000, wait));
      continue;
    }

    if (res.statusCode >= 500) {
      lastError = new Error(`HTTP ${res.statusCode}`);
      const wait = 1000 + Math.random() * 1000;
      logRetry(`HTTP ${res.statusCode}`, wait / 1000, attemptNo, MAX_TRIES, host);
      await sleep(wait);
      continue;
    }

    if (res.statusCode >= 400) {
      const hint = res.body.slice(0, 120).replace(/\s+/g, ' ');
      throw new Error(`HTTP ${res.statusCode}: ${hint}`);
    }
  }

  throw lastError || new Error(`Failed after ${MAX_TRIES} attempts.`);
}

function logRetry(msg, waitSec, n, max, host) {
  process.stdout.write(
    `${CLR_LINE}${YELL}↻${RESET} ${DIM}${msg} from ${host} — retrying in ${waitSec.toFixed(1)}s [${n}/${max}]${RESET}`
  );
}

// =========================================================================
// CSV
// =========================================================================
function saveCsv(symbol, data, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const filename = csvPathFor(symbol, todayString(), outDir);
  const header = 'Date,Open,High,Low,Close,Volume\n';
  const body = data.map(r => `${r.date},${r.open},${r.high},${r.low},${r.close},${r.volume}`).join('\n');
  fs.writeFileSync(filename, header + body + '\n');
  return filename;
}

// =========================================================================
// Slice latest candles to fit terminal width
// =========================================================================
function sliceLatestToWidth(data, maxCandles) {
  if (!Array.isArray(data) || data.length === 0) return [];
  if (!maxCandles || maxCandles >= data.length) return data;
  return data.slice(-maxCandles);
}

// =========================================================================
// Renderer (padded Y-axis scale + accurate half-block body/wick + gap)
// =========================================================================
function overlaps(aLow, aHigh, bLow, bHigh) {
  return Math.max(aLow, bLow) <= Math.min(aHigh, bHigh);
}

function renderChart(data, symbol, height, sourceRowCount = data.length, gapName = opts.gap) {
  if (!data || data.length === 0) {
    console.log(`${YELL}No data to render for ${symbol}${RESET}`);
    return;
  }

  if (!height) height = autoDetectHeight(data);
  height = Math.max(8, height);

  const { rendered: gapStr, colsPerGap } = getGapConfig(gapName);

  const rawMax = Math.max(...data.map(d => d.high));
  const rawMin = Math.min(...data.map(d => d.low));
  const rawRange = rawMax - rawMin;

  const pad = rawRange > 0 ? rawRange * 0.04 : (Math.abs(rawMax) * 0.02 || 1);
  const scaleMin = rawMin - pad;
  const scaleMax = rawMax + pad;
  const scaleRange = scaleMax - scaleMin || 1;

  const totalHalfRows = height * 2;
  const stepPrice = scaleRange / totalHalfRows;
  const bandForHalfRow = k => [scaleMin + k * stepPrice, scaleMin + (k + 1) * stepPrice];

  const candles = data.map(d => ({
    bullish:    d.close >= d.open,
    bodyTop:    Math.max(d.open, d.close),
    bodyBottom: Math.min(d.open, d.close),
    high:       d.high,
    low:        d.low,
  }));

  const LABEL_W = 10;
  const SPINE_W = 1;

  const labelRows = new Array(height).fill(' '.repeat(LABEL_W));
  for (let i = 0; i < 5; i++) {
    const r = Math.round((i * (height - 1)) / 4);
    const midHalfRow = (totalHalfRows - 1) - (r * 2 + 0.5);
    const price = scaleMin + ((midHalfRow + 0.5) / totalHalfRows) * scaleRange;
    labelRows[r] = price.toFixed(2).padStart(LABEL_W - 1) + ' ';
  }

  const rows = [];
  for (let r = 0; r < height; r++) {
    const topK = (totalHalfRows - 1) - r * 2;
    const botK = topK - 1;
    const [topLow, topHigh] = bandForHalfRow(topK);
    const [botLow, botHigh] = botK >= 0 ? bandForHalfRow(botK) : [scaleMin, scaleMin];

    let candleLine = '';
    for (let idx = 0; idx < candles.length; idx++) {
      const cd = candles[idx];
      const col = cd.bullish ? GREEN : RED;

      const topBody = overlaps(topLow, topHigh, cd.bodyBottom, cd.bodyTop);
      const botBody = botK >= 0 && overlaps(botLow, botHigh, cd.bodyBottom, cd.bodyTop);
      const topWick = overlaps(topLow, topHigh, cd.low, cd.high);
      const botWick = botK >= 0 && overlaps(botLow, botHigh, cd.low, cd.high);

      let ch = ' ';
      if (topBody && botBody) {
        ch = `${col}█${RESET}`;
      } else if (topBody && !botBody) {
        ch = botWick ? `${col}█${RESET}` : `${col}▀${RESET}`;
      } else if (!topBody && botBody) {
        ch = topWick ? `${col}█${RESET}` : `${col}▄${RESET}`;
      } else if (topWick || botWick) {
        ch = `${col}│${RESET}`;
      }

      candleLine += ch;
      if (idx < candles.length - 1) {
        candleLine += gapStr;
      }
    }

    rows.push(`${DIM}${labelRows[r]}${RESET}${DIM}│${RESET}${candleLine}`);
  }

  const windowNote = sourceRowCount > candles.length
    ? `, showing latest ${candles.length} of ${sourceRowCount} CSV bars`
    : `, ${candles.length} bars`;
  const header =
    `${BOLD}${CYAN}▏ ${symbol} ${RESET}` +
    `${BOLD}— Candlestick · last 6 months ${RESET}` +
    `${DIM}(daily${windowNote}, gap: ${gapName})${RESET}`;
  const summary =
    `${DIM}High ${rawMax.toFixed(2)}   Low ${rawMin.toFixed(2)}   Range ${rawRange.toFixed(2)}${RESET}   ` +
    `${GREEN}█${RESET}${DIM} bull${RESET}  ${RED}█${RESET}${DIM} bear${RESET}  ` +
    `${GREEN}│${RESET}${DIM} bull wick${RESET}  ${RED}│${RESET}${DIM} bear wick${RESET}`;

  console.log('\n' + header);
  console.log(summary);
  console.log(`${' '.repeat(LABEL_W + SPINE_W)} ${DIM}↑ high${RESET}`);
  rows.forEach(row => console.log(row));
  console.log(`${' '.repeat(LABEL_W + SPINE_W)} ${DIM}↓ low${RESET}`);

  const W = candles.length;
  const chartSpan = Math.max(1, W + Math.max(0, W - 1) * colsPerGap);
  const first = data[0].date;
  const mid   = data[Math.floor(data.length / 2)].date;
  const last  = data[data.length - 1].date;

  console.log(`${' '.repeat(LABEL_W)}${DIM}└${'─'.repeat(chartSpan)}┘${RESET}`);

  const dateLine = new Array(chartSpan).fill(' ');
  const put = (x, s) => {
    if (x < 0) return;
    for (let i = 0; i < s.length; i++) {
      if (x + i >= 0 && x + i < dateLine.length) dateLine[x + i] = s[i];
    }
  };
  put(0, first);
  put(Math.max(0, Math.floor(chartSpan / 2 - mid.length / 2)), mid);
  put(Math.max(0, chartSpan - last.length), last);
  console.log(' '.repeat(LABEL_W + SPINE_W) + DIM + dateLine.join('') + RESET);

  let highIdx = 0, lowIdx = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i].high > data[highIdx].high) highIdx = i;
    if (data[i].low  < data[lowIdx].low)  lowIdx  = i;
  }
  const actualPxPerDollar = (totalHalfRows / scaleRange).toFixed(2);
  console.log(
    `${DIM}highest: ${data[highIdx].high.toFixed(2)} on ${data[highIdx].date}  ` +
    `lowest: ${data[lowIdx].low.toFixed(2)} on ${data[lowIdx].date}  ` +
    `height: ${height} rows (${actualPxPerDollar} half-rows/$)${RESET}`
  );
  console.log();
}

// =========================================================================
// Per-symbol pipeline (CSV-first → fetch-on-miss)
// =========================================================================
async function runOne(symbol) {
  let raw = null;

  if (opts.useCache) {
    const csvData = tryLoadCsv(symbol, opts.outDir);
    if (csvData) {
      raw = csvData;
      process.stdout.write(`${CLR_LINE}${GREEN}✓${RESET} Loaded ${BOLD}${raw.length} rows${RESET} from CSV ${DIM}(no Yahoo fetch)${RESET}\n`);
    }
  }

  if (!raw) {
    process.stdout.write(`${CLR_LINE}${DIM}Fetching ${symbol} from Yahoo Finance…${RESET}`);
    raw = await fetchHistorical(symbol);
    process.stdout.write(`${CLR_LINE}${GREEN}✓${RESET} Fetched ${BOLD}${raw.length} rows${RESET} from Yahoo\n`);
    if (opts.writeCsv) {
      const csvFile = saveCsv(symbol, raw, opts.outDir);
      console.log(`${GREEN}✓${RESET} Saved ${BOLD}${csvFile}${RESET}`);
    }
  }

  if (opts.drawChart) {
    const { colsPerGap } = getGapConfig(opts.gap);
    const maxCandles     = opts.width !== null ? opts.width : autoDetectWidth(raw.length, colsPerGap);
    const view           = sliceLatestToWidth(raw, maxCandles);
    const height         = opts.height !== null ? opts.height : autoDetectHeight(view);
    renderChart(view, symbol, height, raw.length, opts.gap);
  }
}

(async () => {
  let failed = 0;
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    try {
      await runOne(sym);
    } catch (err) {
      process.stdout.write(`${CLR_LINE}${RED}Error:${RESET} ${sym}: ${err.message || err}\n`);
      failed++;
    }
    if (i < symbols.length - 1) await sleep(SYMBOL_DELAY_MS);
  }
  if (failed > 0) process.exit(1);
})();
