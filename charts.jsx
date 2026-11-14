import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";

export const CHART_VERSION = "c8-adx"; // bump to bust the browser cache
console.log("[charts] build", CHART_VERSION);

const DARK = {
  up: "#22c55e",
  down: "#ef4444",
  sma20: "#3b82f6",
  sma50: "#f59e0b",
  ema21: "#34d399",
  bb: "#a855f7",
  vwap: "#22d3ee",
  rsi: "#a78bfa",
  rsi21: "#f472b6",
  macd: "#38bdf8",
  macdSignal: "#fbbf24",
  volSma: "#f97316",
  adx: "#facc15",
  plusDI: "#22c55e",
  minusDI: "#ef4444",
  adxStrong: "rgba(250,204,21,0.12)",
  grid: "#232a36",
  axis: "#8b94a7",
  text: "#e8ecf3",
  pane: "#12161f",
  crosshair: "rgba(232,236,243,0.35)",
  volUp: "rgba(34,197,94,.35)",
  volDown: "rgba(239,68,68,.35)",
  rsiOver: "rgba(239,68,68,.08)",
  rsiUnder: "rgba(34,197,94,.08)",
  histUp: "rgba(34,197,94,.55)",
  histDown: "rgba(239,68,68,.55)",
  bbFill: "rgba(168,85,247,0.13)",
  pctOver: "rgba(239,68,68,.10)",
  pctUnder: "rgba(34,197,94,.10)",
};

const LIGHT = {
  up: "#16a34a",
  down: "#dc2626",
  sma20: "#2563eb",
  sma50: "#d97706",
  ema21: "#059669",
  bb: "#9333ea",
  vwap: "#0891b2",
  rsi: "#7c3aed",
  rsi21: "#db2777",
  macd: "#0284c7",
  macdSignal: "#ca8a04",
  volSma: "#ea580c",
  adx: "#ca8a04",
  plusDI: "#16a34a",
  minusDI: "#dc2626",
  adxStrong: "rgba(202,138,4,0.10)",
  grid: "#e2e8f0",
  axis: "#64748b",
  text: "#1e293b",
  pane: "#f3f5f9",
  crosshair: "rgba(30,41,59,0.28)",
  volUp: "rgba(22,163,74,.30)",
  volDown: "rgba(220,38,38,.30)",
  rsiOver: "rgba(220,38,38,.08)",
  rsiUnder: "rgba(22,163,74,.08)",
  histUp: "rgba(22,163,74,.50)",
  histDown: "rgba(220,38,38,.50)",
  bbFill: "rgba(147,51,234,0.10)",
  pctOver: "rgba(220,38,38,.10)",
  pctUnder: "rgba(22,163,74,.10)",
};

export const COLORS = DARK;
const C = DARK;

function palette(theme) {
  return theme === "light" ? LIGHT : DARK;
}

const MONTH_MS = 30.44 * 24 * 3600 * 1000;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (v, d = 2) => (v == null || v === undefined || !isFinite(v) ? "—" : Number(v).toFixed(d));
const fmtDate = (t) =>
  new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

export function PriceChart({ bars = [], months = 6, height = 470, variant = "candles", theme = "dark" }) {
  const C = palette(theme);
  // NOTE: callback refs (never null, never the wrong node) + hit-testing via e.currentTarget
  const canvasEl = useRef(null);
  const wrapEl = useRef(null);
  const setCanvas = useCallback((el) => { canvasEl.current = el; }, []);
  const setWrap = useCallback((el) => { wrapEl.current = el; }, []);

  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState(null);
  const [view, setView] = useState({ start: 0, count: 0 });
  const dragRef = useRef(null);

  const windowBars = useMemo(() => {
    if (!bars || !bars.length) return [];
    if (months >= 12) return bars;
    const cutoff = Date.now() - months * MONTH_MS;
    let s = bars.findIndex((b) => b.t >= cutoff);
    if (s === -1) s = Math.max(0, bars.length - 60);
    return bars.slice(s);
  }, [bars, months]);

  useEffect(() => setView({ start: 0, count: 0 }), [windowBars]);

  const count = view.count || windowBars.length || 1;
  const start = clamp(view.start, 0, Math.max(0, windowBars.length - count));
  const visible = useMemo(() => windowBars.slice(start, start + count), [windowBars, start, count]);

  const geom = useMemo(() => {
    const PAD = { top: 10, right: 56, bottom: 22, left: 4, gap: 10 };
    const measured = width > 50 ? width : (wrapEl.current ? wrapEl.current.clientWidth : 0);
    const W = Math.max(300, measured || 640);
    const H = height;
    const plotX = PAD.left;
    const plotW = Math.max(60, W - PAD.left - PAD.right);
    const innerH = Math.max(140, H - PAD.top - PAD.bottom);
    const gaps = PAD.gap * (variant === "bands" ? 1 : 4);
    const usable = innerH - gaps;
    const defs =
      variant === "bands"
        ? [{ key: "price", h: usable * 0.72 }, { key: "pctb", h: usable * 0.28 }]
        : [
            { key: "price", h: usable * 0.50 },
            { key: "vol", h: usable * 0.08 },
            { key: "rsi", h: usable * 0.14 },
            { key: "macd", h: usable * 0.14 },
            { key: "adx", h: usable * 0.14 },
          ];
    let top = PAD.top;
    const panes = defs.map((d) => {
      const p = { ...d, top };
      top += d.h + PAD.gap;
      return p;
    });
    return { W, H, PAD, plotX, plotW, panes, barW: plotW / Math.max(1, count) };
  }, [width, height, count, variant]);

  const draw = useCallback(() => {
    const canvas = canvasEl.current;
    if (!canvas || typeof canvas.getContext !== "function") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const g = geom;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const logicalW = g.W;
    canvas.width = Math.round(logicalW * dpr);
    canvas.height = Math.round(g.H * dpr);
    canvas.style.width = "100%";
    canvas.style.height = g.H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, logicalW, g.H);
    if (!visible.length) {
      ctx.fillStyle = C.axis;
      ctx.font = "12px system-ui";
      ctx.fillText("No chart data", 12, 20);
      return;
    }

    const P = (k) => g.panes.find((p) => p.key === k) || g.panes[0];
    const pricePane = P("price");
    const lastPane = g.panes[g.panes.length - 1];
    const xAt = (i) => g.plotX + (i + 0.5) * g.barW;

    let min = Infinity, max = -Infinity, maxVol = 0, macdAbs = 0.0001;
    for (const b of visible) {
      if (variant === "bands") {
        min = Math.min(min, b.c, b.bbL ?? b.c, b.vwap ?? b.c);
        max = Math.max(max, b.c, b.bbU ?? b.c, b.vwap ?? b.c);
      } else {
        min = Math.min(min, b.l, b.sma20 ?? b.l, b.sma50 ?? b.l, b.ema21 ?? b.l);
        max = Math.max(max, b.h, b.sma20 ?? b.h, b.sma50 ?? b.h, b.ema21 ?? b.h);
      }
      maxVol = Math.max(maxVol, b.v || 0, b.volSma21 || 0);
      if (b.macd != null) macdAbs = Math.max(macdAbs, Math.abs(b.macd));
      if (b.macdSignal != null) macdAbs = Math.max(macdAbs, Math.abs(b.macdSignal));
    }
    if (!isFinite(min) || !isFinite(max) || max === min) {
      min = (max || 1) * 0.99;
      max = (max || 1) * 1.01;
    }
    const padY = (max - min) * 0.06 || 1;
    min -= padY;
    max += padY;

    const yPrice = (p) => pricePane.top + pricePane.h - ((p - min) / (max - min)) * pricePane.h;

    g.panes.forEach((p) => {
      ctx.fillStyle = C.pane;
      ctx.fillRect(g.plotX, p.top, g.plotW, p.h);
    });

    ctx.font = "10px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    for (let k = 0; k <= 4; k++) {
      const p = min + ((max - min) * k) / 4;
      const y = yPrice(p);
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(g.plotX, y);
      ctx.lineTo(g.plotX + g.plotW, y);
      ctx.stroke();
      ctx.fillStyle = C.axis;
      ctx.textAlign = "left";
      ctx.fillText(p.toFixed(2), g.plotX + g.plotW + 6, y);
    }

    const lineOn = (key, color, width, dash, mapper) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < visible.length; i++) {
        const v = visible[i][key];
        if (v == null || v === undefined || !isFinite(v)) continue;
        const x = xAt(i);
        const y = mapper(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };

    if (variant === "bands") {
      // Bollinger band fill
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < visible.length; i++) {
        const v = visible[i].bbU;
        if (v == null || v === undefined) continue;
        const x = xAt(i);
        if (!started) { ctx.moveTo(x, yPrice(v)); started = true; } else ctx.lineTo(x, yPrice(v));
      }
      for (let i = visible.length - 1; i >= 0; i--) {
        const v = visible[i].bbL;
        if (v == null || v === undefined) continue;
        ctx.lineTo(xAt(i), yPrice(v));
      }
      if (started) {
        ctx.closePath();
        ctx.fillStyle = C.bbFill;
        ctx.fill();
      }
      lineOn("bbU", C.bb, 1.3, [5, 4], yPrice);
      lineOn("bbL", C.bb, 1.3, [5, 4], yPrice);
      lineOn("bbM", C.bb, 1.1, [2, 3], yPrice);
      lineOn("sma20", C.sma20, 1.2, [], yPrice);
      lineOn("vwap", C.vwap, 1.5, [], yPrice);
      lineOn("ema21", C.ema21, 1.2, [6, 3], yPrice);
      ctx.strokeStyle = C.text;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      visible.forEach((b, i) => {
        const x = xAt(i), y = yPrice(b.c);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    } else {
      const bw = Math.max(1, Math.min(14, g.barW * 0.62));
      for (let i = 0; i < visible.length; i++) {
        const b = visible[i];
        const up = b.c >= b.o;
        const color = up ? C.up : C.down;
        const x = Math.round(xAt(i)) + 0.5;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, yPrice(b.h));
        ctx.lineTo(x, yPrice(b.l));
        ctx.stroke();
        const yo = yPrice(b.o), yc = yPrice(b.c);
        ctx.fillStyle = color;
        ctx.fillRect(xAt(i) - bw / 2, Math.min(yo, yc), bw, Math.max(1, Math.abs(yc - yo)));
      }
      lineOn("sma50", C.sma50, 1.6, [], yPrice);
      lineOn("sma20", C.sma20, 1.6, [], yPrice);
      lineOn("ema21", C.ema21, 1.4, [6, 3], yPrice);
    }

    if (variant !== "bands") {
      const vp = P("vol");
      const yVol = (v) => vp.top + vp.h - (maxVol ? (v / maxVol) * vp.h : 0);
      const vw = Math.max(1, Math.min(10, g.barW * 0.6));
      for (let i = 0; i < visible.length; i++) {
        const b = visible[i];
        if (!b.v) continue;
        ctx.fillStyle = b.c >= b.o ? C.volUp : C.volDown;
        const y = yVol(b.v);
        ctx.fillRect(xAt(i) - vw / 2, y, vw, vp.top + vp.h - y);
      }
      lineOn("volSma21", C.volSma, 1.4, [], yVol);
      ctx.fillStyle = C.axis;
      ctx.textAlign = "left";
      ctx.fillText("VOL", g.plotX + 4, vp.top + 8);
      ctx.fillStyle = C.volSma;
      ctx.fillText("SMA21", g.plotX + 32, vp.top + 8);
    }

    if (variant !== "bands") {
      const rp = P("rsi");
      const yRsi = (r) => rp.top + rp.h - (r / 100) * rp.h;
      ctx.fillStyle = C.rsiOver;
      ctx.fillRect(g.plotX, rp.top, g.plotW, (70 / 100) * rp.h);
      ctx.fillStyle = C.rsiUnder;
      ctx.fillRect(g.plotX, rp.top + (70 / 100) * rp.h, g.plotW, (30 / 100) * rp.h);
      ctx.strokeStyle = C.grid;
      ctx.setLineDash([3, 3]);
      [30, 50, 70].forEach((lv) => {
        const y = yRsi(lv);
        ctx.beginPath();
        ctx.moveTo(g.plotX, y);
        ctx.lineTo(g.plotX + g.plotW, y);
        ctx.stroke();
      });
      ctx.setLineDash([]);
      lineOn("rsi", C.rsi, 1.4, [], yRsi);
      lineOn("rsi21", C.rsi21, 1.2, [5, 3], yRsi);
      ctx.fillStyle = C.rsi;
      ctx.textAlign = "left";
      ctx.fillText("RSI 14", g.plotX + 4, rp.top + 9);
      ctx.fillStyle = C.rsi21;
      ctx.fillText("RSI 21", g.plotX + 52, rp.top + 9);
    }

    if (variant !== "bands") {
      const mp = P("macd");
      const yM = (m) => mp.top + mp.h / 2 - (m / macdAbs) * (mp.h / 2);
      const hw = Math.max(1, Math.min(8, g.barW * 0.5));
      for (let i = 0; i < visible.length; i++) {
        const h = visible[i].macdHist;
        if (h == null || h === undefined) continue;
        const zero = yM(0);
        const y = yM(h);
        ctx.fillStyle = h >= 0 ? C.histUp : C.histDown;
        ctx.fillRect(xAt(i) - hw / 2, Math.min(y, zero), hw, Math.max(1, Math.abs(y - zero)));
      }
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(g.plotX, yM(0));
      ctx.lineTo(g.plotX + g.plotW, yM(0));
      ctx.stroke();
      lineOn("macd", C.macd, 1.5, [], yM);
      lineOn("macdSignal", C.macdSignal, 1.3, [], yM);
      ctx.fillStyle = C.macd;
      ctx.textAlign = "left";
      ctx.fillText("MACD 12/26/9", g.plotX + 4, mp.top + 9);
      ctx.fillStyle = C.macdSignal;
      ctx.fillText("signal 9", g.plotX + 88, mp.top + 9);
    }

    if (variant !== "bands") {
      const ap = P("adx");
      const yAdx = (v) => ap.top + ap.h - (Math.max(0, Math.min(100, v)) / 100) * ap.h;
      // strong-trend zone (ADX > 25)
      ctx.fillStyle = C.adxStrong;
      ctx.fillRect(g.plotX, ap.top, g.plotW, (75 / 100) * ap.h);
      ctx.strokeStyle = C.grid;
      ctx.setLineDash([3, 3]);
      [20, 25, 40].forEach((lv) => {
        const y = yAdx(lv);
        ctx.beginPath();
        ctx.moveTo(g.plotX, y);
        ctx.lineTo(g.plotX + g.plotW, y);
        ctx.stroke();
      });
      ctx.setLineDash([]);
      lineOn("adx", C.adx, 1.6, [], yAdx);
      lineOn("plusDI", C.plusDI, 1.2, [], yAdx);
      lineOn("minusDI", C.minusDI, 1.2, [], yAdx);
      ctx.fillStyle = C.adx;
      ctx.textAlign = "left";
      ctx.fillText("ADX", g.plotX + 4, ap.top + 9);
      ctx.fillStyle = C.plusDI;
      ctx.fillText("+DI", g.plotX + 36, ap.top + 9);
      ctx.fillStyle = C.minusDI;
      ctx.fillText("-DI", g.plotX + 62, ap.top + 9);
      ctx.fillStyle = C.axis;
      ctx.fillText("25", g.plotX + g.plotW + 6, yAdx(25));
    }

    if (variant === "bands") {
      const bp = P("pctb");
      const yB = (v) => bp.top + bp.h - (v / 100) * bp.h;
      ctx.fillStyle = C.pctOver;
      ctx.fillRect(g.plotX, bp.top, g.plotW, (20 / 100) * bp.h);
      ctx.fillStyle = C.pctUnder;
      ctx.fillRect(g.plotX, bp.top + (80 / 100) * bp.h, g.plotW, (20 / 100) * bp.h);
      ctx.strokeStyle = C.grid;
      ctx.setLineDash([3, 3]);
      [0, 50, 100].forEach((lv) => {
        const y = yB(lv);
        ctx.beginPath();
        ctx.moveTo(g.plotX, y);
        ctx.lineTo(g.plotX + g.plotW, y);
        ctx.stroke();
      });
      ctx.setLineDash([]);
      lineOn("pctB", C.bb, 1.5, [], yB);
      ctx.fillStyle = C.bb;
      ctx.textAlign = "left";
      ctx.fillText("%B (20, 2\u03c3c)", g.plotX + 4, bp.top + 9);
      ctx.fillStyle = C.axis;
      ctx.fillText("100", g.plotX + g.plotW + 6, yB(100));
      ctx.fillText("0", g.plotX + g.plotW + 6, yB(0));
    }
    if (hover && hover.i != null && visible[hover.i]) {
      const hx = xAt(hover.i);
      ctx.save();
      ctx.strokeStyle = C.crosshair;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, g.panes[0].top);
      ctx.lineTo(hx, g.panes[g.panes.length - 1].top + g.panes[g.panes.length - 1].h);
      ctx.stroke();
      ctx.restore();
    }
  }, [geom, visible, hover, variant, theme]);

  useEffect(() => { draw(); }, [draw]);

  useEffect(() => {
    const el = wrapEl.current;
    if (!el) return;
    const update = () => {
      const w = Math.floor(el.clientWidth || el.getBoundingClientRect().width || 0);
      if (w > 40 && Math.abs(w - width) > 2) setWidth(w);
    };
    update();
    let ro = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => update());
      ro.observe(el);
    }
    window.addEventListener("resize", update);
    // also recheck after a short delay for layout settle
    const t = setTimeout(update, 80);
    return () => {
      clearTimeout(t);
      if (ro) ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [width]);

  useEffect(() => {
    const canvas = canvasEl.current;
    if (!canvas || !canvas.addEventListener) return;
    const onWheel = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof canvas.getBoundingClientRect !== "function") return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const bw = geom.plotW / Math.max(1, count);
      const mouseBar = clamp(Math.floor((x - geom.plotX) / bw), 0, Math.max(0, visible.length - 1));
      const anchor = start + mouseBar;
      const factor = e.deltaY > 0 ? 1.2 : 0.82; // scroll down = zoom out, up = zoom in
      const newCount = clamp(Math.round(count * factor), 15, windowBars.length || 15);
      let newStart = Math.round(anchor - mouseBar * (newCount / count));
      newStart = clamp(newStart, 0, Math.max(0, windowBars.length - newCount));
      setView({ start: newStart, count: newCount });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [geom, count, start, visible.length, windowBars.length]);

  // hit-testing uses displayed canvas size so it stays accurate after responsive resize
  const onPointerMove = (e) => {
    const el = e.currentTarget || canvasEl.current;
    if (!el || typeof el.getBoundingClientRect !== "function") return;
    const rect = el.getBoundingClientRect();
    const displayedW = rect.width || el.clientWidth || geom.W;
    const scale = displayedW > 0 ? geom.W / displayedW : 1;
    const x = (e.clientX - rect.left) * scale;
    const y = (e.clientY - rect.top) * scale;
    const i = clamp(Math.floor((x - geom.plotX) / Math.max(0.1, geom.barW)), 0, Math.max(0, visible.length - 1));
    setHover({ i, x: e.clientX - rect.left, y: e.clientY - rect.top, logicalX: x });
    if (dragRef.current) {
      const shift = Math.round(-(e.clientX - dragRef.current.x) / Math.max(1, geom.barW / scale));
      const newStart = clamp(dragRef.current.start + shift, 0, Math.max(0, windowBars.length - count));
      setView((v) => ({ ...v, start: newStart }));
    }
  };

  const hb = hover && visible[hover.i];

  return (
    <div className="chart-wrap" ref={setWrap}>
      <canvas
        ref={setCanvas}
        className="chart-canvas"
        style={{ height, touchAction: "none" }}
        onPointerDown={(e) => {
          dragRef.current = { x: e.clientX, start };
          if (e.currentTarget && e.currentTarget.setPointerCapture) {
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
          }
        }}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => {
          dragRef.current = null;
          if (e.currentTarget && e.currentTarget.releasePointerCapture) {
            try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
          }
        }}
        onPointerLeave={() => setHover(null)}
      />
      {hb ? (
        <div
          className="chart-tip"
          style={{ 
            left: Math.min(hover.x + 16, Math.max(8, (geom.W || 400) - 210)), 
            top: Math.max(6, Math.min(hover.y - 8, height - 140)) 
          }}
        >
          <div className="chart-tip-date">{fmtDate(hb.t)}</div>
          {variant === "bands" ? (
            <>
              <div>Close <b>{fmt(hb.c)}</b></div>
              <div>
                <span style={{ color: C.bb }}>BB up {fmt(hb.bbU)}</span>{" "}
                <span style={{ color: C.bb }}>BB dn {fmt(hb.bbL)}</span>
              </div>
              <div><span style={{ color: C.vwap }}>VWAP {fmt(hb.vwap)}</span></div>
              <div>
                <span style={{ color: C.bb }}>%B {fmt(hb.pctB, 1)}</span>{" "}
                <span style={{ color: C.ema21 }}>EMA21 {fmt(hb.ema21)}</span>
              </div>
            </>
          ) : (
            <>
              <div>O <b>{fmt(hb.o)}</b> &nbsp; H <b>{fmt(hb.h)}</b></div>
              <div>L <b>{fmt(hb.l)}</b> &nbsp; C <b>{fmt(hb.c)}</b></div>
              <div>
                Vol {((hb.v || 0) / 1e6).toFixed(2)}M{" "}
                <span style={{ color: C.volSma }}>SMA21 {hb.volSma21 != null ? ((hb.volSma21) / 1e6).toFixed(2) + "M" : "—"}</span>
              </div>
              <div>
                <span style={{ color: C.sma20 }}>SMA20 {fmt(hb.sma20)}</span>{" "}
                <span style={{ color: C.sma50 }}>SMA50 {fmt(hb.sma50)}</span>
              </div>
              <div><span style={{ color: C.ema21 }}>EMA21 {fmt(hb.ema21)}</span></div>
              <div>
                <span style={{ color: C.rsi }}>RSI14 {fmt(hb.rsi, 1)}</span>{" "}
                <span style={{ color: C.rsi21 }}>RSI21 {fmt(hb.rsi21, 1)}</span>
              </div>
              <div>
                <span style={{ color: C.macd }}>MACD {fmt(hb.macd, 3)}</span>{" "}
                <span style={{ color: C.macdSignal }}>sig {fmt(hb.macdSignal, 3)}</span>
              </div>
              <div>
                <span style={{ color: C.adx }}>ADX {fmt(hb.adx, 1)}</span>{" "}
                <span style={{ color: C.plusDI }}>+DI {fmt(hb.plusDI, 1)}</span>{" "}
                <span style={{ color: C.minusDI }}>-DI {fmt(hb.minusDI, 1)}</span>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

