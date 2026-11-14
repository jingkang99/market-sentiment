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

<img width="1107" height="968" alt="image" src="https://github.com/user-attachments/assets/509828c5-f35e-48d1-b5dc-a418fd80d838" />
