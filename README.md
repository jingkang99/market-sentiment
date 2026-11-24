## **Bullish or Bearish 1 Panel Dashboard - BBD**

Check the Current Stock Market Sentiment  
Built with AI

## Workflow

```
Yahoo Finance
    ↓  fetchYahoo / normalizeChart
server.js  GET /api/quote/:symbol
    ↓  fetchYahooChart → fetchLocalQuote
app.jsx  loadData() → React state
    ↓  analyze(bars)
indicators.js  → latest values + enriched bars
    ↓  contextFrom → getSignal / combineSignals
signals.js  → score + label + reasons
    ↓
StockCard (numbers + signal)
PriceChart (candles / bands / RSI / MACD)
MarketBreadth tiles
```

## Stock Watchlist

Modify stock symbols in public/breadth-stocks.txt, up to 11 stocks to check

## Start Server

```
npm install
PORT=3000 HOST=0.0.0.0 npm start --loglevel verbose
```

## Build Executable

```
npm run build
npx pkg . --targets node18-win-x64 --out-path dist
```

## Command Line Tools, zero dependency
- Check Market Momentum
- Draw Candlestick Chart

```
node candlestick.js v

node momentums.mjs
```
<img width="1244" height="777" alt="image" src="https://github.com/user-attachments/assets/7d372dce-b8fd-4dc3-8672-eadffc6c247a" />

<img width="617" height="1254" alt="image" src="https://github.com/user-attachments/assets/410f6831-0f35-42d9-9049-844b3c693d26" />

<img width="1093" height="1363" alt="image" src="https://github.com/user-attachments/assets/3942cdd9-2610-4bdc-a26d-9a9e3539ef53" />

