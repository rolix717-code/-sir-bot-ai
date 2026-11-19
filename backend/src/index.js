const ALLOWED_ORIGIN = "https://sirbotai.com.de";
const MARKET_BASE = "https://api.realmarketapi.com";
const TCHAVI_URL = "https://tchavi.com/api/v1/chat/completions";

const SYMBOL = "XAUUSD";
const TIMEFRAMES = ["M5", "M15", "H1", "H4"];
const A_PLUS_MIN_SCORE = 85;
const MIN_CONFIDENCE = 70;
const SIGNAL_TTL = 86400;
const MAX_M5_AGE_MS = 20 * 60 * 1000;
const ACCURACY_PREFIX = "accuracy:signal:";
const ACCURACY_TTL = 30 * 24 * 60 * 60;

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

function cors() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });
}

function authorized(request, env) {
  return Boolean(
    env.TELEGRAM_TEST_SECRET &&
    request.headers.get("Authorization") === `Bearer ${env.TELEGRAM_TEST_SECRET}`
  );
}

// MT5 bridge authentication is separate from dashboard and Telegram secrets.
function mt5BridgeAuthorized(request, env) {
  return Boolean(
    env.MT5_BRIDGE_SECRET &&
    request.headers.get("Authorization") === `Bearer ${env.MT5_BRIDGE_SECRET}`
  );
}

async function ensureMT5QueueTable(env) {
  if (!env.DB) throw new Error("D1 binding DB is required for the MT5 bridge.");
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS mt5_signal_queue (
      signal_id TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('BUY','SELL')),
      entry REAL NOT NULL,
      stop_loss REAL NOT NULL,
      tp1 REAL NOT NULL,
      tp2 REAL NOT NULL,
      tp3 REAL NOT NULL,
      confidence REAL NOT NULL,
      setup_score REAL NOT NULL,
      candle_time TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      claimed_at TEXT,
      acknowledged_at TEXT,
      bridge_result TEXT,
      UNIQUE(symbol, timeframe, candle_time, decision)
    )
  `).run();
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_mt5_queue_pending ON mt5_signal_queue(status, expires_at, created_at)`).run();
}

async function enqueueMT5Signal(env, signal) {
  if (!signal || !["BUY", "SELL"].includes(signal.decision)) return { queued: false };
  await ensureMT5QueueTable(env);
  const now = new Date();
  const expires = new Date(now.getTime() + 5 * 60 * 1000);
  const identity = [signal.symbol || SYMBOL, signal.timeframe || "M5", signal.candleTime, signal.decision].join("|");
  const signalId = await sha256(identity);
  const result = await env.DB.prepare(`
    INSERT INTO mt5_signal_queue (
      signal_id, symbol, timeframe, decision, entry, stop_loss, tp1, tp2, tp3,
      confidence, setup_score, candle_time, created_at, expires_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
    ON CONFLICT(symbol, timeframe, candle_time, decision) DO NOTHING
  `).bind(
    signalId, signal.symbol || SYMBOL, signal.timeframe || "M5", signal.decision,
    signal.entry, signal.stopLoss, signal.tp1, signal.tp2, signal.tp3,
    signal.confidence, signal.setupScore, signal.candleTime,
    now.toISOString(), expires.toISOString()
  ).run();
  return { queued: (result.meta?.changes || 0) > 0, signalId };
}

async function mt5NextSignal(env) {
  await ensureMT5QueueTable(env);
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE mt5_signal_queue SET status='EXPIRED' WHERE status='PENDING' AND expires_at <= ?`).bind(now).run();
  const claimed = await env.DB.prepare(`
    UPDATE mt5_signal_queue
    SET status='CLAIMED', claimed_at=?
    WHERE signal_id=(
      SELECT signal_id FROM mt5_signal_queue
      WHERE status='PENDING' AND expires_at > ?
      ORDER BY created_at ASC LIMIT 1
    ) AND status='PENDING'
    RETURNING signal_id, symbol, timeframe, decision, entry, stop_loss, tp1, tp2, tp3,
              confidence, setup_score, candle_time, expires_at
  `).bind(now, now).first();
  if (!claimed) return { success: true, signal: null, message: "No pending signal." };
  return {
    success: true,
    signal: {
      signalId: claimed.signal_id,
      symbol: claimed.symbol,
      timeframe: claimed.timeframe,
      decision: claimed.decision,
      entry: claimed.entry,
      stopLoss: claimed.stop_loss,
      tp1: claimed.tp1,
      tp2: claimed.tp2,
      tp3: claimed.tp3,
      confidence: claimed.confidence,
      setupScore: claimed.setup_score,
      candleTime: claimed.candle_time,
      expiresAt: claimed.expires_at,
      executionMode: "LIVE_MT5"
    }
  };
}

async function mt5AcknowledgeSignal(env, body) {
  const signalId = String(body.signalId || "").trim();
  const result = String(body.result || "").toUpperCase();
  if (!/^[a-f0-9]{64}$/i.test(signalId)) return response({ error: "Valid signalId is required." }, 400);
  if (!["RECEIVED", "REJECTED", "EXECUTED", "DUPLICATE"].includes(result)) {
    return response({ error: "result must be RECEIVED, REJECTED, EXECUTED, or DUPLICATE." }, 400);
  }
  await ensureMT5QueueTable(env);
  const updated = await env.DB.prepare(`
    UPDATE mt5_signal_queue
    SET status='ACKNOWLEDGED', acknowledged_at=?, bridge_result=?
    WHERE signal_id=? AND status='CLAIMED'
    RETURNING signal_id
  `).bind(new Date().toISOString(), result, signalId).first();
  if (!updated) return response({ error: "Signal not found, already acknowledged, or not claimed." }, 409);
  return response({ success: true, signalId, result });
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestamp(value) {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) {
      const n = Number(value);
      return n < 1e12 ? n * 1000 : n;
    }
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function normalizeCandle(c) {
  if (!c || typeof c !== "object") return null;
  const time = timestamp(c.OpenTime ?? c.openTime ?? c.time ?? c.timestamp ?? c.date);
  const open = num(c.OpenPrice ?? c.openPrice ?? c.open);
  const high = num(c.HighPrice ?? c.highPrice ?? c.high);
  const low = num(c.LowPrice ?? c.lowPrice ?? c.low);
  const close = num(c.ClosePrice ?? c.closePrice ?? c.close);
  const volume = num(c.Volume ?? c.volume ?? 0);

  if (time === null || open === null || high === null || low === null || close === null) return null;
  if (high < low || high < open || high < close || low > open || low > close) return null;

  return {
    timestamp: time,
    time: new Date(time).toISOString(),
    open, high, low, close,
    volume: volume ?? 0
  };
}

function normalizeCandles(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : payload?.Data ?? payload?.data ?? payload?.items ?? payload?.candles ?? [];

  if (!Array.isArray(rows)) throw new Error("Invalid candle response from market API.");

  const unique = new Map();
  for (const row of rows) {
    const candle = normalizeCandle(row);
    if (candle) unique.set(candle.timestamp, candle);
  }

  return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-300);
}

async function marketRequest(env, endpoint, timeframe) {
  if (!env.REALMARKETAPI_KEY) throw new Error("REALMARKETAPI_KEY is missing.");

  const url = new URL(`${MARKET_BASE}/api/v1/${endpoint}`);
  url.searchParams.set("apiKey", env.REALMARKETAPI_KEY);
  url.searchParams.set("symbolCode", SYMBOL);
  url.searchParams.set("timeFrame", timeframe);

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();

  if (!res.ok) {
    throw new Error(`RealMarketAPI ${endpoint} error ${res.status}: ${data.Message ?? data.message ?? "Request failed"}`);
  }
  return data;
}

async function getLatestPrice(env, timeframe = "M5") {
  const data = await marketRequest(env, "price", timeframe);
  const candle = normalizeCandle(data);
  if (!candle) throw new Error("Could not read latest price response. Check API response format.");

  const ageMs = Date.now() - candle.timestamp;
  return {
    symbol: SYMBOL,
    timeframe,
    price: candle.close,
    candleTime: candle.time,
    timestamp: candle.timestamp,
    ageMinutes: Math.round(ageMs / 60000),
    fresh: ageMs >= -120000 && ageMs <= MAX_M5_AGE_MS
  };
}

async function getCandles(env, timeframe) {
  const data = await marketRequest(env, "candle", timeframe);
  const candles = normalizeCandles(data);
  if (candles.length < 50) throw new Error(`${timeframe}: only ${candles.length} valid candles received.`);
  return candles;
}

// -------------------------
// INDICATORS
// -------------------------

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    result = values[i] * multiplier + result * (1 - multiplier);
  }
  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    ranges.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const recent = ranges.slice(-period);
  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);
  if (fast === null || slow === null) return null;
  return { value: fast - slow };
}

function structure(candles) {
  const recent = candles.slice(-20);
  const previous = recent.slice(0, -1);
  const last = recent.at(-1);
  const highest = Math.max(...previous.map(c => c.high));
  const lowest = Math.min(...previous.map(c => c.low));
  let state = "RANGE";

  if (last.close > highest) state = "BULLISH BREAKOUT";
  else if (last.close < lowest) state = "BEARISH BREAKOUT";
  else {
    const prev = recent.at(-2);
    if (last.high > prev.high && last.low > prev.low) state = "POSSIBLE BULLISH STRUCTURE";
    else if (last.high < prev.high && last.low < prev.low) state = "POSSIBLE BEARISH STRUCTURE";
  }
  return { state, resistance: highest, support: lowest };
}

function indicators(candles) {
  const closes = candles.map(c => c.close);
  const last = candles.at(-1);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  let trend = "SIDEWAYS";

  if (ema20 !== null && ema50 !== null) {
    if (last.close > ema20 && ema20 > ema50) trend = "BULLISH";
    else if (last.close < ema20 && ema20 < ema50) trend = "BEARISH";
  }
  return {
    symbol: SYMBOL, price: last.close, candleTime: last.time, trend,
    ema20, ema50, rsi: rsi(closes), atr: atr(candles),
    macd: macd(closes), structure: structure(candles)
  };
}

// -------------------------
// ADVANCED PRICE-ACTION INTELLIGENCE
// -------------------------

function advancedPriceAction(candles) {
  const recent = candles.slice(-60);
  const last = recent.at(-1);
  const prior = recent.slice(0, -1);
  const rangeHigh = Math.max(...prior.slice(-20).map(c => c.high));
  const rangeLow = Math.min(...prior.slice(-20).map(c => c.low));
  const midpoint = (rangeHigh + rangeLow) / 2;

  const bullishSweep = last.low < rangeLow && last.close > rangeLow;
  const bearishSweep = last.high > rangeHigh && last.close < rangeHigh;
  const bullishBOS = last.close > rangeHigh;
  const bearishBOS = last.close < rangeLow;

  const a = recent.at(-3), b = recent.at(-2), c = last;
  const bullishFVG = a.high < c.low;
  const bearishFVG = a.low > c.high;

  // Approximate the last opposing candle before a strong displacement candle.
  let bullishOrderBlock = null;
  let bearishOrderBlock = null;
  if (recent.length >= 5) {
    const impulse = recent.at(-1);
    const body = Math.abs(impulse.close - impulse.open);
    const averageRange = recent.slice(-15, -1).reduce((sum, x) => sum + (x.high - x.low), 0) / Math.max(1, recent.slice(-15, -1).length);
    if (body > averageRange * 1.2) {
      const opposite = [...recent.slice(-6, -1)].reverse().find(x =>
        impulse.close > impulse.open ? x.close < x.open : x.close > x.open
      );
      if (opposite && impulse.close > impulse.open) bullishOrderBlock = { low: opposite.low, high: opposite.high };
      if (opposite && impulse.close < impulse.open) bearishOrderBlock = { low: opposite.low, high: opposite.high };
    }
  }

  return {
    rangeHigh, rangeLow, equilibrium: midpoint,
    zone: last.close > midpoint ? "PREMIUM" : last.close < midpoint ? "DISCOUNT" : "EQUILIBRIUM",
    liquiditySweep: bullishSweep ? "BULLISH_SWEEP" : bearishSweep ? "BEARISH_SWEEP" : "NONE",
    structureBreak: bullishBOS ? "BULLISH_BOS" : bearishBOS ? "BEARISH_BOS" : "NO_CONFIRMED_BOS",
    fairValueGap: bullishFVG ? "BULLISH_FVG" : bearishFVG ? "BEARISH_FVG" : "NONE",
    bullishOrderBlock, bearishOrderBlock,
    candleBody: Math.abs(last.close - last.open),
    candleRange: last.high - last.low
  };
}

function buildIntelligence(market) {
  // Multi-family confluence engine. Each family is scored once to avoid
  // counting several correlated indicators as independent evidence.
  const frames = ["H4", "H1", "M15", "M5"];
  const trends = Object.fromEntries(frames.map(tf => [tf, market[tf].indicators.trend]));
  const priceAction = Object.fromEntries(frames.map(tf => [tf, advancedPriceAction(market[tf].candles)]));
  const m5 = market.M5.indicators;
  const m15 = market.M15.indicators;
  const h1 = market.H1.indicators;
  const h4 = market.H4.indicators;
  const pa = priceAction.M5;

  function score(direction) {
    const bullish = direction === "BUY";
    const desiredTrend = bullish ? "BULLISH" : "BEARISH";
    const oppositeTrend = bullish ? "BEARISH" : "BULLISH";
    let points = 0;
    const confirmations = [];
    const reasons = [];
    const add = (family, weight, reason) => {
      points += weight;
      confirmations.push(family);
      reasons.push(reason);
    };

    // 1) Multi-timeframe trend / moving-average structure (maximum 25)
    const aligned = frames.filter(tf => trends[tf] === desiredTrend).length;
    const opposed = frames.filter(tf => trends[tf] === oppositeTrend).length;
    if (aligned >= 3) add("Trend & EMA structure", aligned >= 4 ? 25 : 20, `${aligned}/4 timeframes show ${desiredTrend.toLowerCase()} EMA structure`);
    else if (aligned === 2) add("Trend & EMA structure", 12, "Two timeframes align with the proposed direction");
    if (opposed >= 2) { points -= 12; reasons.push(`${opposed} timeframes oppose the proposed direction`); }

    // 2) Momentum: RSI and MACD are grouped as one family (maximum 15)
    const rsiGood = bullish ? m5.rsi >= 50 && m5.rsi <= 70 : m5.rsi <= 50 && m5.rsi >= 30;
    const macdGood = bullish ? Number(m5.macd?.value) > 0 : Number(m5.macd?.value) < 0;
    if (rsiGood && macdGood) add("Momentum", 15, "M5 RSI and MACD support the same direction");
    else if (rsiGood || macdGood) add("Momentum", 8, rsiGood ? "M5 RSI supports direction" : "M5 MACD supports direction");

    // 3) Structure and liquidity: BOS / sweep (maximum 20)
    const sweepGood = bullish ? pa.liquiditySweep === "BULLISH_SWEEP" : pa.liquiditySweep === "BEARISH_SWEEP";
    const bosGood = bullish ? pa.structureBreak === "BULLISH_BOS" : pa.structureBreak === "BEARISH_BOS";
    if (sweepGood && bosGood) add("Structure & liquidity", 20, "Liquidity sweep and break of structure agree");
    else if (sweepGood || bosGood) add("Structure & liquidity", 12, sweepGood ? "Directional liquidity sweep detected" : "Directional break of structure detected");

    // 4) ICT-style imbalance / FVG and approximate order-block context (maximum 15)
    const fvgGood = bullish ? pa.fairValueGap === "BULLISH_FVG" : pa.fairValueGap === "BEARISH_FVG";
    const orderBlock = bullish ? pa.bullishOrderBlock : pa.bearishOrderBlock;
    const price = m5.price;
    const inOrderBlock = Boolean(orderBlock && price >= orderBlock.low && price <= orderBlock.high);
    if (fvgGood && inOrderBlock) add("FVG & order-block confluence", 15, "Directional fair-value gap and price within the approximate order-block zone");
    else if (fvgGood || inOrderBlock) add("FVG & order-block confluence", 8, fvgGood ? "Directional fair-value gap detected" : "Price is testing the approximate directional order-block zone");

    // 5) Premium/discount and range location (maximum 10)
    const correctZone = bullish ? pa.zone === "DISCOUNT" : pa.zone === "PREMIUM";
    if (correctZone) add("Range location", 10, `Price is in the ${pa.zone.toLowerCase()} half of the recent range`);

    // 6) Candle / breakout quality and volatility guard (maximum 10)
    const candleDirectional = bullish ? m5.price > market.M5.candles.at(-1).open : m5.price < market.M5.candles.at(-1).open;
    const volatilityOk = Number(m5.atr) > 0 && Number(pa.candleRange) <= Number(m5.atr) * 2.5;
    const breakoutRetestContext = bullish
      ? m5.price > pa.rangeHigh || (m5.price > pa.equilibrium && candleDirectional)
      : m5.price < pa.rangeLow || (m5.price < pa.equilibrium && candleDirectional);
    if (volatilityOk && candleDirectional && breakoutRetestContext) add("Price action & volatility", 10, "Directional candle and volatility conditions are acceptable");
    else if (volatilityOk && candleDirectional) add("Price action & volatility", 5, "Directional candle with acceptable volatility");

    const scoreValue = Math.max(0, Math.min(100, Math.round(points)));
    return {
      score: scoreValue,
      reasons,
      confirmations: [...new Set(confirmations)],
      aligned,
      opposed,
      higherConflict: [h4, h1, m15].some(x => x.trend === oppositeTrend)
    };
  }

  const buy = score("BUY");
  const sell = score("SELL");
  const selected = buy.score >= sell.score ? { decision: "BUY", ...buy } : { decision: "SELL", ...sell };
  return {
    trends,
    priceAction,
    buy,
    sell,
    ...selected,
    strategyFamilies: [
      "Multi-timeframe trend and EMA structure",
      "RSI/MACD momentum",
      "Market structure and liquidity sweeps",
      "Fair value gaps and approximate order blocks",
      "Premium/discount range location",
      "Price action and volatility filters"
    ],
    threshold: A_PLUS_MIN_SCORE
  };
}

// -------------------------
// AI
// -------------------------

function parseAI(text) {
  if (!text) throw new Error("AI returned an empty response.");
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("AI did not return valid JSON.");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function validateAI(data) {
  const decision = String(data.decision ?? "").toUpperCase();
  const trend = String(data.trend ?? "").toUpperCase();
  const confidence = Number(data.confidence);

  if (!["BUY", "SELL", "WAIT"].includes(decision)) throw new Error("Invalid AI decision.");
  if (!["BULLISH", "BEARISH", "SIDEWAYS"].includes(trend)) throw new Error("Invalid AI trend.");
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw new Error("Invalid AI confidence.");

  return {
    decision, trend, confidence,
    reasoning: String(data.reasoning ?? ""),
    risk_warning: String(data.risk_warning ?? "")
  };
}

function strategyProfile(value) {
  const strategy = String(value || "NORMAL").toUpperCase();
  if (strategy === "AGGRESSIVE_SCALPER") return {
    id: strategy, label: "Aggressive AI Scalper", confidence: 70, score: 85,
    entryTimeframe: "M5", context: ["M15", "H1"],
    prompt: "Use a faster M5 momentum/breakout approach with M15 confirmation and H1 context. Look for clean momentum continuation, retests, and volatility expansion. Avoid chasing extended candles and avoid entries when spread/volatility conditions are unsuitable. This is still selective; do not manufacture trades."
  };
  return {
    id: "NORMAL", label: "Normal AI Trader", confidence: 70, score: 85,
    entryTimeframe: "M5", context: ["M15", "H1", "H4"],
    prompt: "Use a selective multi-timeframe trend approach. H4/H1 provide directional context, M15 confirms structure, and M5 is used only for entry timing. Prefer aligned trends, support/resistance and supply/demand confluence. Wait when timeframes conflict."
  };
}

async function analyzeChartImage(request, env) {
  if (!env.TCHAVI_API_KEY) return response({ error: "TCHAVI_API_KEY is missing in Cloudflare Workers." }, 503);
  if (request.method !== "POST") return response({ error: "POST method required." }, 405);

  let form;
  try { form = await request.formData(); }
  catch { return response({ error: "Upload a chart image using multipart form data." }, 400); }

  const file = form.get("chart");
  const timeframe = String(form.get("timeframe") || "M5").toUpperCase();
  if (!file || typeof file.arrayBuffer !== "function") return response({ error: "Chart image is required." }, 400);
  if (!["M1", "M5", "M15", "H1", "H4", "D1"].includes(timeframe)) return response({ error: "Unsupported timeframe." }, 400);
  if (file.size <= 0 || file.size > 5 * 1024 * 1024) return response({ error: "Image must be between 1 byte and 5 MB." }, 413);

  const mime = String(file.type || "").toLowerCase();
  if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) return response({ error: "Only PNG, JPG and WEBP images are supported." }, 415);

  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)));
  }
  const imageDataUrl = `data:${mime};base64,${btoa(binary)}`;

  const systemPrompt = `You are SIR BOT AI Vision, an image-based XAUUSD chart analyst. Examine only what is visibly present in the uploaded chart screenshot. The chart timeframe is ${timeframe}. Return ONLY valid JSON with this exact shape:
{"decision":"WAIT","trend":"SIDEWAYS","confidence":0,"market_structure":"unclear","entry":null,"stop_loss":null,"take_profit_1":null,"take_profit_2":null,"take_profit_3":null,"support":null,"resistance":null,"reasoning":"","risk_warning":""}
Rules: decision must be BUY, SELL, or WAIT. trend must be BULLISH, BEARISH, or SIDEWAYS. confidence must be an integer 0-100 and is not a win probability. Numeric levels must be numbers or null. Never guess unreadable prices, instrument, or levels. If symbol is not clearly XAUUSD, chart is cropped/blurred, price scale is unreadable, or evidence is mixed, choose WAIT and explain. Only propose entry/SL/TP when a clear setup is visible; keep stop loss beyond invalidation and targets in the direction of the trade with sensible risk/reward. Do not claim live price access. Include a concise market_structure and reasoning. risk_warning must state that screenshot analysis is not live data and must be independently verified. This is analysis only and must never trigger a trade.`;

  let upstream;
  try {
    upstream = await fetch(TCHAVI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TCHAVI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.1,
        max_tokens: 900,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: [
            { type: "text", text: `Analyze this XAUUSD chart screenshot on ${timeframe}. Return the required JSON only.` },
            { type: "image_url", image_url: { url: imageDataUrl } }
          ] }
        ]
      }),
      signal: AbortSignal.timeout(55000)
    });
  } catch (error) {
    return response({ error: error?.name === "TimeoutError" ? "Vision analysis timed out. Try again with a smaller screenshot." : "Could not reach the AI vision service." }, 502);
  }

  const upstreamData = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const detail = upstreamData?.error?.message || upstreamData?.message || `AI provider returned HTTP ${upstream.status}.`;
    return response({ error: `Vision AI error: ${String(detail).slice(0, 300)}` }, 502);
  }

  try {
    const raw = upstreamData.choices?.[0]?.message?.content;
    const parsed = parseAI(typeof raw === "string" ? raw : JSON.stringify(raw));
    const decision = String(parsed.decision || "WAIT").toUpperCase();
    const trend = String(parsed.trend || "SIDEWAYS").toUpperCase();
    const confidence = Number(parsed.confidence);
    if (!["BUY", "SELL", "WAIT"].includes(decision)) throw new Error("Vision AI returned an invalid decision.");
    if (!["BULLISH", "BEARISH", "SIDEWAYS"].includes(trend)) throw new Error("Vision AI returned an invalid trend.");
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) throw new Error("Vision AI returned invalid confidence.");
    const level = value => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
    const analysis = {
      decision, trend, confidence: Math.round(confidence),
      market_structure: String(parsed.market_structure || "Not clear from screenshot"),
      entry: level(parsed.entry), stop_loss: level(parsed.stop_loss),
      take_profit_1: level(parsed.take_profit_1), take_profit_2: level(parsed.take_profit_2),
      take_profit_3: level(parsed.take_profit_3), support: level(parsed.support),
      resistance: level(parsed.resistance), reasoning: String(parsed.reasoning || "No reasoning provided."),
      risk_warning: String(parsed.risk_warning || "Screenshot-only analysis. Verify all levels against live market data before making any decision.")
    };
    return response({ success: true, timeframe, analysis, source: "uploaded_screenshot_only", execution: "disabled" });
  } catch (error) {
    return response({ error: `Could not read the AI vision result: ${error.message}` }, 502);
  }
}

async function analyzeAI(market, env, profile = strategyProfile("NORMAL")) {
  if (!env.TCHAVI_API_KEY) throw new Error("TCHAVI_API_KEY is missing.");

  const system = `
You are SIR BOT AI, a cautious XAUUSD market analysis assistant.
Analyze the supplied H4, H1, M15 and M5 data for the ${profile.label} profile.
${profile.prompt}
Consider:
- Multi-timeframe trend alignment and EMA structure
- RSI/MACD momentum confluence (treat correlated indicators as one evidence family)
- ATR volatility and candle quality
- Support/resistance and recent range location
- Market structure, break of structure and liquidity sweeps
- Fair value gaps and approximate order-block context
- Breakout/retest conditions and premium/discount location
- Do not count correlated indicators as separate independent confirmations
Never invent prices or indicators.
Return ONLY JSON:
{
  "decision": "WAIT",
  "trend": "SIDEWAYS",
  "confidence": 50,
  "reasoning": "Explanation",
  "risk_warning": "Risk warning"
}
Decision: BUY, SELL, or WAIT.
Trend: BULLISH, BEARISH, or SIDEWAYS.
Confidence: number from 0 to 100.
If the timeframes disagree, data is unclear, or the setup is weak, choose WAIT. Do not fabricate a high confidence score. The deterministic intelligence score is a separate gate; only setups scoring at least 85/100 can become trade signals.
Confidence is not a guaranteed win probability.
`;

  const res = await fetch(TCHAVI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TCHAVI_API_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(market) }
      ]
    }),
    signal: AbortSignal.timeout(30000)
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`AI error ${res.status}: ${data.error?.message ?? "Request failed"}`);
  return validateAI(parseAI(data.choices?.[0]?.message?.content));
}

// -------------------------
// SIGNAL
// -------------------------

function makeSignal(analysis, ind, profile = strategyProfile("NORMAL")) {
  if (analysis.decision === "WAIT") return { decision: "WAIT", reason: analysis.reasoning };
  if (analysis.confidence < profile.confidence) return { decision: "WAIT", reason: "AI confidence is below the required threshold." };
  if (!Number.isFinite(analysis.setupScore) || analysis.setupScore < profile.score) {
    return { decision: "WAIT", reason: `A+ filter not met. Deterministic setup score: ${analysis.setupScore ?? "N/A"}/100; minimum required: ${profile.score}.` };
  }
  if (analysis.decision !== analysis.setupDirection) {
    return { decision: "WAIT", reason: `AI direction conflicts with the deterministic intelligence engine (${analysis.setupDirection}, ${analysis.setupScore}/100).` };
  }
  if (!ind.atr || ind.atr <= 0) return { decision: "WAIT", reason: "ATR is unavailable." };

  if (analysis.decision === "BUY" && analysis.trend !== "BULLISH") {
    return { decision: "WAIT", reason: "BUY does not match the AI trend." };
  }
  if (analysis.decision === "SELL" && analysis.trend !== "BEARISH") {
    return { decision: "WAIT", reason: "SELL does not match the AI trend." };
  }

  const entry = ind.price;
  const distance = ind.atr * 1.5;
  let sl, tp1, tp2, tp3;

  if (analysis.decision === "BUY") {
    sl = entry - distance;
    tp1 = entry + distance;
    tp2 = entry + distance * 2;
    tp3 = entry + distance * 3;
  } else {
    sl = entry + distance;
    tp1 = entry - distance;
    tp2 = entry - distance * 2;
    tp3 = entry - distance * 3;
  }

  return {
    symbol: SYMBOL, timeframe: profile.entryTimeframe, strategy: profile.id, decision: analysis.decision,
    entry: Number(entry.toFixed(3)),
    stopLoss: Number(sl.toFixed(3)),
    tp1: Number(tp1.toFixed(3)),
    tp2: Number(tp2.toFixed(3)),
    tp3: Number(tp3.toFixed(3)),
    confidence: analysis.confidence, setupScore: analysis.setupScore, trend: analysis.trend,
    candleTime: ind.candleTime, reasoning: analysis.reasoning,
    riskWarning: analysis.risk_warning, status: "UNEXECUTED"
  };
}

// -------------------------
// TELEGRAM
// -------------------------

async function sendTelegramToChat(env, chatId, message) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("Telegram bot token is missing.");
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000)
  });
  const data = await res.json();
  if (!res.ok || data.ok !== true) throw new Error(`Telegram failed: ${data.description ?? res.status}`);
  return data;
}

// Telegram subscribers are stored in the existing Cloudflare D1 database.
async function ensureTelegramSubscribersTable(env) {
  if (!env.DB) throw new Error("D1 binding DB is required for multi-user Telegram support.");
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS telegram_subscribers (
      chat_id TEXT PRIMARY KEY,
      first_name TEXT,
      username TEXT,
      chat_type TEXT NOT NULL DEFAULT 'private',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();
}

async function registerTelegramSubscriber(env, message) {
  await ensureTelegramSubscribersTable(env);
  const chatId = String(message.chat.id);
  const firstName = String(message.from?.first_name || '').slice(0, 100);
  const username = String(message.from?.username || '').slice(0, 100);
  await env.DB.prepare(`
    INSERT INTO telegram_subscribers (chat_id, first_name, username, chat_type, active, created_at, last_seen_at)
    VALUES (?, ?, ?, 'private', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(chat_id) DO UPDATE SET
      first_name=excluded.first_name,
      username=excluded.username,
      active=1,
      last_seen_at=CURRENT_TIMESTAMP
  `).bind(chatId, firstName, username).run();
}

async function deactivateTelegramSubscriber(env, chatId) {
  await ensureTelegramSubscribersTable(env);
  await env.DB.prepare("UPDATE telegram_subscribers SET active=0, last_seen_at=CURRENT_TIMESTAMP WHERE chat_id=?")
    .bind(String(chatId)).run();
}

async function getTelegramSubscriberIds(env) {
  await ensureTelegramSubscribersTable(env);
  const result = await env.DB.prepare("SELECT chat_id FROM telegram_subscribers WHERE active=1").all();
  const ids = new Set((result.results || []).map(row => String(row.chat_id)));
  // Keep the original owner/admin destination working during the migration.
  if (env.TELEGRAM_CHAT_ID) ids.add(String(env.TELEGRAM_CHAT_ID));
  return [...ids];
}

async function sendTelegram(env, message) {
  const chatIds = await getTelegramSubscriberIds(env);
  if (!chatIds.length) throw new Error("No Telegram subscribers yet. Open the bot and press /start.");
  const results = await Promise.allSettled(chatIds.map(async chatId => {
    try {
      await sendTelegramToChat(env, chatId, message);
      return chatId;
    } catch (error) {
      // Telegram returns 403 when a user blocks the bot or their account is unavailable.
      if (/blocked|chat not found|deactivated/i.test(error.message)) {
        await deactivateTelegramSubscriber(env, chatId);
      }
      throw error;
    }
  }));
  const sent = results.filter(item => item.status === "fulfilled").length;
  const failed = results.length - sent;
  console.log(`Telegram broadcast complete: ${sent} sent, ${failed} failed.`);
  return { sent, failed, total: chatIds.length };
}

function formatSignal(signal) {
  return `
🟡 SIR BOT AI — XAUUSD
📊 SIGNAL: ${signal.decision}
⏱ TIMEFRAME: ${signal.timeframe}
━━━━━━━━━━━━━━━━━━
📍 ENTRY: ${signal.entry}
🛑 STOP LOSS: ${signal.stopLoss}
🎯 TP1: ${signal.tp1}
🎯 TP2: ${signal.tp2}
🎯 TP3: ${signal.tp3}
━━━━━━━━━━━━━━━━━━
📈 TREND: ${signal.trend}
🧠 AI SCORE: ${signal.confidence}/100
🏆 CONFLUENCE SCORE: ${signal.setupScore ?? "N/A"}/100
🧩 CONFIRMED FAMILIES: ${(signal.strategyConfirmations || []).join(", ") || "Not supplied"}
🕒 CANDLE: ${signal.candleTime}
📝 ANALYSIS:
${signal.reasoning}
⚠️ RISK:
${signal.riskWarning || "Trading involves risk."}
━━━━━━━━━━━━━━━━━━
STATUS: ANALYSIS ONLY
SIGNAL BROADCASTS: CLEAR BUY/SELL ONLY
SIR BOT AI
`.trim();
}

// -------------------------
// DUPLICATE PROTECTION
// -------------------------

function signalKey(signal) {
  return ["signal", signal.strategy || "NORMAL", signal.symbol, signal.timeframe, signal.decision, signal.candleTime].join(":");
}

async function sendUniqueSignal(env, signal) {
  if (!env.SIGNAL_DEDUPE) throw new Error("SIGNAL_DEDUPE KV binding is missing.");
  const key = signalKey(signal);
  const previous = await env.SIGNAL_DEDUPE.get(key);
  if (previous) return { sent: false, duplicate: true };

  await sendTelegram(env, formatSignal(signal));
  await env.SIGNAL_DEDUPE.put(
    key,
    JSON.stringify({ sentAt: new Date().toISOString(), candleTime: signal.candleTime }),
    { expirationTtl: SIGNAL_TTL }
  );
  return { sent: true, duplicate: false };
}

// -------------------------
// SIGNAL ACCURACY TRACKING
// -------------------------

async function recordSignalForTracking(env, signal) {
  if (!env.SIGNAL_DEDUPE || !signal || !["BUY", "SELL"].includes(signal.decision)) return;
  const id = `${signal.strategy || "NORMAL"}:${signal.candleTime}:${signal.decision}`;
  const key = ACCURACY_PREFIX + encodeURIComponent(id);
  const existing = await env.SIGNAL_DEDUPE.get(key);
  if (existing) return;

  const record = {
    id,
    symbol: signal.symbol || SYMBOL,
    decision: signal.decision,
    entry: signal.entry,
    stopLoss: signal.stopLoss,
    takeProfit: signal.tp1,
    tp1: signal.tp1,
    tp2: signal.tp2,
    tp3: signal.tp3,
    strategy: signal.strategy || "NORMAL",
    hitTargets: [],
    confidence: signal.confidence,
    candleTime: signal.candleTime,
    entryTimestamp: Date.parse(signal.candleTime),
    status: "PENDING",
    outcome: null,
    createdAt: new Date().toISOString()
  };

  await env.SIGNAL_DEDUPE.put(key, JSON.stringify(record), { expirationTtl: ACCURACY_TTL });
}

async function listAccuracyRecords(env) {
  if (!env.SIGNAL_DEDUPE) throw new Error("SIGNAL_DEDUPE KV binding is missing.");
  const records = [];
  let cursor;

  do {
    const page = await env.SIGNAL_DEDUPE.list({
      prefix: ACCURACY_PREFIX,
      limit: 1000,
      ...(cursor ? { cursor } : {})
    });

    for (const item of page.keys || []) {
      const raw = await env.SIGNAL_DEDUPE.get(item.name);
      if (!raw) continue;
      try {
        records.push(JSON.parse(raw));
      } catch (error) {
        console.error("Skipping invalid accuracy record:", item.name);
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return records.sort((a, b) => (b.entryTimestamp || 0) - (a.entryTimestamp || 0));
}

async function monitorPendingSignals(env) {
  if (!env.SIGNAL_DEDUPE) throw new Error("SIGNAL_DEDUPE KV binding is missing.");

  const records = await listAccuracyRecords(env);
  const pending = records.filter(r => r.status === "PENDING" && Number.isFinite(r.entryTimestamp));
  if (!pending.length) return { checked: 0, events: [] };

  const candles = await getCandles(env, "M5");
  const events = [];
  const targets = ["tp1", "tp2", "tp3"];

  for (const record of pending) {
    const laterCandles = candles.filter(c => c.timestamp > record.entryTimestamp);
    let changed = false;
    for (const candle of laterCandles) {
      const isBuy = record.decision === "BUY";
      const stopHit = isBuy ? candle.low <= record.stopLoss : candle.high >= record.stopLoss;
      const newlyHit = targets.filter(name =>
        Number.isFinite(Number(record[name])) &&
        !(record.hitTargets || []).includes(name.toUpperCase()) &&
        (isBuy ? candle.high >= Number(record[name]) : candle.low <= Number(record[name]))
      );

      // If SL and a target are both inside the same M5 candle, their order is
      // unknowable. Do not claim a TP hit; record the conservative SL outcome.
      if (stopHit) {
        record.status = "RESOLVED";
        record.outcome = "LOSS";
        record.exitPrice = record.stopLoss;
        record.resolutionReason = newlyHit.length
          ? "SL and an unreported TP level touched in the same M5 candle; counted conservatively as SL."
          : "Stop loss reached.";
        record.resolutionCandle = candle.time;
        record.resolvedAt = new Date().toISOString();
        const slEvent = { ...record, eventType: "SL" };
        events.push(slEvent);
        record.pendingNotifications = [...(record.pendingNotifications || []), slEvent];
        changed = true;
        break;
      }

      for (const targetName of newlyHit) {
        const targetNumber = targetName.toUpperCase();
        record.hitTargets = [...(record.hitTargets || []), targetNumber];
        record.lastHitTarget = targetNumber;
        record.lastHitPrice = Number(record[targetName]);
        record.lastHitAt = new Date().toISOString();
        const targetEvent = { ...record, eventType: targetNumber, exitPrice: record.lastHitPrice };
        events.push(targetEvent);
        record.pendingNotifications = [...(record.pendingNotifications || []), targetEvent];
        changed = true;
        if (targetName === "tp3") {
          record.status = "RESOLVED";
          record.outcome = "WIN";
          record.exitPrice = Number(record.tp3);
          record.resolutionReason = "TP3 reached; all take-profit targets were reached.";
          record.resolutionCandle = candle.time;
          record.resolvedAt = new Date().toISOString();
          break;
        }
      }
      if (record.status === "RESOLVED") break;
    }

    if (changed) {
      const key = ACCURACY_PREFIX + encodeURIComponent(record.id);
      await env.SIGNAL_DEDUPE.put(key, JSON.stringify(record), { expirationTtl: ACCURACY_TTL });
    }
  }

  return { checked: pending.length, events };
}

function calculateAccuracy(records) {
  const wins = records.filter(r => r.status === "RESOLVED" && r.outcome === "WIN").length;
  const losses = records.filter(r => r.status === "RESOLVED" && r.outcome === "LOSS").length;
  const pending = records.filter(r => r.status === "PENDING").length;
  const resolved = wins + losses;

  return {
    total: records.length,
    wins,
    losses,
    pending,
    resolved,
    winRate: resolved ? Number((wins / resolved * 100).toFixed(1)) : null
  };
}

async function getAccuracyReport(env) {
  const records = await listAccuracyRecords(env);
  return { ...calculateAccuracy(records), records: records.slice(0, 30) };
}

function formatOutcomeReport(record) {
  const isStop = record.eventType === "SL";
  const target = record.eventType;
  return `
${isStop ? "🛑 STOP LOSS HIT" : `✅ ${target} HIT`} — SIR BOT AI
━━━━━━━━━━━━━━━━━━
📊 SIGNAL: ${record.decision}
🧠 STRATEGY: ${record.strategy || "NORMAL"}
💱 SYMBOL: ${record.symbol || SYMBOL}
📍 ENTRY: ${record.entry}
🛑 STOP LOSS: ${record.stopLoss}
🎯 TP1: ${record.tp1 ?? record.takeProfit}
🎯 TP2: ${record.tp2 ?? "N/A"}
🎯 TP3: ${record.tp3 ?? "N/A"}
📌 EVENT: ${isStop ? "STOP LOSS" : `${target} reached`}
📉 PRICE: ${record.exitPrice}
🕒 TIME: ${record.lastHitAt || record.resolvedAt || new Date().toISOString()}
━━━━━━━━━━━━━━━━━━
Signal tracking only; broker execution and fills may differ.
SIR BOT AI
`.trim();
}

function formatAccuracyReport(report) {
  const rate = report.winRate === null ? "N/A" : `${report.winRate}%`;
  return `
📊 SIR BOT AI — SIGNAL PERFORMANCE
━━━━━━━━━━━━━━━━━━
Tracked signals: ${report.total}
✅ TP1 wins: ${report.wins}
❌ Stop-loss losses: ${report.losses}
⏳ Still pending: ${report.pending}
Resolved signals: ${report.resolved}
🎯 Completed-signal rate: ${rate}
━━━━━━━━━━━━━━━━━━
Method: reports each TP1, TP2, and TP3 hit; SL ends tracking. Levels touched in the same M5 candle as SL are treated conservatively as SL.
If both are touched in one candle, it is counted as an SL.
This is historical signal tracking, not guaranteed future performance.
Telegram broadcasts: clear BUY/SELL signals only
`.trim();
}

// -------------------------
// MARKET WORKFLOW
// -------------------------

async function collectMarket(env) {
  const result = {};
  for (const tf of TIMEFRAMES) {
    const candles = await getCandles(env, tf);
    result[tf] = { candles, indicators: indicators(candles) };
  }
  return result;
}

function checkFreshness(latestPrice) {
  if (!latestPrice.fresh) {
    return {
      fresh: false,
      reason: `Latest completed M5 candle is ${latestPrice.ageMinutes} minutes old.`
    };
  }
  return { fresh: true, candleTime: latestPrice.candleTime };
}

function higherTimeframesAgree(decision, market) {
  const m15 = market.M15.indicators.trend;
  const h1 = market.H1.indicators.trend;
  const h4 = market.H4.indicators.trend;
  if (decision === "BUY") return m15 === "BULLISH" && h1 === "BULLISH" && h4 === "BULLISH";
  if (decision === "SELL") return m15 === "BEARISH" && h1 === "BEARISH" && h4 === "BEARISH";
  return false;
}

function aiInput(market) {
  const data = {};
  for (const tf of TIMEFRAMES) {
    data[tf] = {
      indicators: market[tf].indicators,
      candles: market[tf].candles.slice(-100).map(c => ({
        time: c.time, open: c.open, high: c.high,
        low: c.low, close: c.close, volume: c.volume
      }))
    };
  }
  return {
    symbol: SYMBOL,
    entryTimeframe: "M5",
    confirmationTimeframes: ["M15", "H1", "H4"],
    timeframes: data
  };
}

async function runAnalysis(env, notify = false, requestedStrategy = "NORMAL") {
  const profile = strategyProfile(requestedStrategy);
  const latestPrice = await getLatestPrice(env, "M5");
  const freshness = checkFreshness(latestPrice);

  if (!freshness.fresh) {
    return {
      success: false, decision: "WAIT", reason: freshness.reason,
      latestPrice, alertsAllowed: false
    };
  }

  const market = await collectMarket(env);
  const m5Candle = market.M5.candles.at(-1);

  if (Math.abs(m5Candle.timestamp - latestPrice.timestamp) > 10 * 60 * 1000) {
    return {
      success: false,
      decision: "WAIT",
      reason: "The /price and /candle endpoints disagree on the latest M5 candle.",
      latestPrice,
      candleTime: m5Candle.time,
      alertsAllowed: false
    };
  }

  const intelligence = buildIntelligence(market);
  const analysis = await analyzeAI({ ...aiInput(market), strategy: profile.id, deterministicIntelligence: intelligence }, env, profile);
  analysis.setupScore = intelligence.score;
  analysis.setupDirection = intelligence.decision;
  analysis.intelligenceReasons = intelligence.reasons;
  let signal = makeSignal(analysis, market.M5.indicators, profile);
  if (signal.decision !== "WAIT") {
    signal.strategyConfirmations = intelligence.confirmations || [];
    signal.strategyFamiliesChecked = intelligence.strategyFamilies || [];
    signal.setupReasons = intelligence.reasons || [];
  }

  if (signal.decision !== "WAIT") {
    const aligned = profile.id === "AGGRESSIVE_SCALPER"
      ? ((signal.decision === "BUY" && market.M15.indicators.trend === "BULLISH") || (signal.decision === "SELL" && market.M15.indicators.trend === "BEARISH"))
      : higherTimeframesAgree(signal.decision, market);
    if (!aligned) signal = { decision: "WAIT", strategy: profile.id, reason: profile.id === "AGGRESSIVE_SCALPER" ? "M15 momentum does not confirm the M5 entry." : "M15, H1 and H4 do not confirm the M5 direction." };
  }

  let telegram = { sent: false, duplicate: false };
  if (notify && signal.decision !== "WAIT") telegram = await sendUniqueSignal(env, signal);

  return {
    success: true,
    symbol: SYMBOL,
    strategy: { id: profile.id, label: profile.label, entryTimeframe: profile.entryTimeframe, confirmationTimeframes: profile.context },
    latestPrice,
    analysis,
    signal,
    market: {
      M5: market.M5.indicators,
      M15: market.M15.indicators,
      H1: market.H1.indicators,
      H4: market.H4.indicators,
      intelligence
    },
    telegram,
    alertsAllowed: true,
    checkedAt: new Date().toISOString()
  };
}

// -------------------------
// TELEGRAM COMMAND HANDLER
// -------------------------

async function handleTelegramCommand(env, message) {
  const chatId = String(message.chat?.id ?? "");
  const text = String(message.text ?? "").trim();
  if (!chatId || !text) return;

  const command = text.split(/\s+/)[0].split("@")[0].toLowerCase();

  if (command === "/start") {
    if (message.chat?.type !== "private") {
      await sendTelegramToChat(env, chatId, "Please open SIR BOT AI in a private chat and press /start to subscribe to signals.");
      return;
    }
    await registerTelegramSubscriber(env, message);
    await sendTelegramToChat(env, chatId, `
🟡 WELCOME TO SIR BOT AI
You are now subscribed to XAUUSD signals and automatic market reports.
Available commands:
/start - Subscribe / reactivate
/stop - Stop receiving automatic signals
/help - Show commands
/status - Check system status
/signal - Request fresh XAUUSD analysis
/performance - View tracked signal results
━━━━━━━━━━━━━━━━━━
Market: XAUUSD
Analysis: M5 / M15 / H1 / H4
Automatic reports: Every 5 minutes when the scheduled trigger is active.
Telegram broadcasts: clear BUY/SELL signals only
SIR BOT AI
`.trim());
    return;
  }

  if (command === "/stop") {
    await deactivateTelegramSubscriber(env, chatId);
    await sendTelegramToChat(env, chatId, "You have been unsubscribed from automatic SIR BOT AI broadcasts. Send /start any time to subscribe again.");
    return;
  }

  if (command === "/help") {
    await sendTelegramToChat(env, chatId, `
🟡 SIR BOT AI — COMMANDS
/start
Open the welcome message.
/stop
Stop receiving automatic signals.
/help
Show this command guide.
/status
Check backend and market data.
/signal
Request a new XAUUSD analysis.
/performance
Show tracked BUY/SELL results and TP1 hit rate.
Signals are analysis only.
No trades are executed automatically.
SIR BOT AI
`.trim());
    return;
  }

  if (command === "/status") {
    const latest = await getLatestPrice(env, "M5");
    await sendTelegramToChat(env, chatId, `
🟡 SIR BOT AI — SYSTEM STATUS
Backend: ONLINE
AI: ${env.TCHAVI_API_KEY ? "CONFIGURED" : "MISSING"}
Market data: ${env.REALMARKETAPI_KEY ? "CONFIGURED" : "MISSING"}
Telegram: CONFIGURED
KV: ${env.SIGNAL_DEDUPE ? "CONFIGURED" : "MISSING"}
━━━━━━━━━━━━━━━━━━
Symbol: ${SYMBOL}
Latest price: ${latest.price}
Timeframe: ${latest.timeframe}
Candle time: ${latest.candleTime}
Candle age: ${latest.ageMinutes} minutes
Fresh: ${latest.fresh ? "YES" : "NO"}
Telegram broadcasts: clear BUY/SELL signals only
SIR BOT AI
`.trim());
    return;
  }

  if (command === "/signal") {
    // User-requested analysis is silent unless a valid BUY or SELL signal exists.
    try {
      const result = await runAnalysis(env, false);
      if (result.success && ["BUY", "SELL"].includes(result.signal?.decision)) {
        await sendTelegramToChat(env, chatId, formatSignal(result.signal));
      }
    } catch (error) {
      // Keep Telegram clean: diagnostics stay in Worker logs, not subscriber chats.
      console.error("Telegram /signal analysis failed:", error);
    }
    return;
  }

  if (command === "/performance") {
    const report = await getAccuracyReport(env);
    await sendTelegramToChat(env, chatId, formatAccuracyReport(report));
    return;
  }

  await sendTelegramToChat(env, chatId, "Unknown command. Send /help to see available commands.");
}

async function telegramWebhook(request, env) {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return response({ error: "Webhook secret is missing." }, 500);
  const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (suppliedSecret !== env.TELEGRAM_WEBHOOK_SECRET) return response({ error: "Invalid webhook secret." }, 401);
  if (!env.SIGNAL_DEDUPE) return response({ error: "KV binding is missing." }, 500);

  const update = await request.json();
  if (!Number.isInteger(update.update_id)) return response({ success: true, ignored: true });

  const key = `telegram-update:${update.update_id}`;
  const previous = await env.SIGNAL_DEDUPE.get(key);
  if (previous) return response({ success: true, duplicate: true });

  await env.SIGNAL_DEDUPE.put(key, "processed", { expirationTtl: SIGNAL_TTL });

  try {
    if (update.message) await handleTelegramCommand(env, update.message);
  } catch (error) {
    console.error("Telegram webhook error:", error);
    await env.SIGNAL_DEDUPE.delete(key);
    return response({ error: "Command processing failed." }, 500);
  }
  return response({ success: true });
}

// -------------------------
// WEBHOOK REGISTRATION
// -------------------------

async function registerTelegramWebhook(env) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing.");
  if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error("TELEGRAM_WEBHOOK_SECRET is missing.");

  const webhookUrl = "https://sir-bot-ai-backend.rolix717.workers.dev/telegram-webhook";
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message"],
      drop_pending_updates: false
    }),
    signal: AbortSignal.timeout(15000)
  });

  const data = await res.json();
  if (!res.ok || data.ok !== true) throw new Error(`Webhook registration failed: ${data.description ?? res.status}`);
  return { success: true, message: "Telegram webhook registered successfully." };
}

// -------------------------
// AUTOMATIC CRON
// -------------------------

function kampalaTime() {
  return new Date().toLocaleString("en-UG", {
    timeZone: "Africa/Kampala",
    dateStyle: "medium",
    timeStyle: "medium"
  });
}

async function scheduledAnalysis(env) {
  // Telegram broadcast policy: send valid BUY/SELL signals and each TP1/TP2/TP3/SL
  // BUY/SELL signal messages only. WAIT decisions, TP/SL reports, market summaries,
  // and system errors are never broadcast to subscribers.
  try {
    const tracking = await monitorPendingSignals(env);
    console.log("SIR BOT signal tracking checked:", JSON.stringify({
      checked: tracking.checked,
      events: tracking.events.length
    }));

    // Retry undelivered TP/SL notifications on later cron runs. Keep each
    // event until Telegram confirms delivery so temporary outages don't lose it.
    const notificationRecords = await listAccuracyRecords(env);
    for (const tracked of notificationRecords) {
      const queued = tracked.pendingNotifications || [];
      if (!queued.length) continue;
      const remaining = [];
      for (const event of queued) {
        try {
          await sendTelegram(env, formatOutcomeReport(event));
        } catch (telegramError) {
          console.error("Telegram TP/SL outcome report failed; will retry:", telegramError.message);
          remaining.push(event);
        }
      }
      if (remaining.length !== queued.length) {
        tracked.pendingNotifications = remaining;
        const key = ACCURACY_PREFIX + encodeURIComponent(tracked.id);
        await env.SIGNAL_DEDUPE.put(key, JSON.stringify(tracked), { expirationTtl: ACCURACY_TTL });
      }
    }

    const results = await Promise.all([
      runAnalysis(env, false, "NORMAL"),
      runAnalysis(env, false, "AGGRESSIVE_SCALPER")
    ]);

    const broadcasts = [];
    for (const result of results) {
      if (!result.success || !result.signal || !["BUY", "SELL"].includes(result.signal.decision)) {
        console.log("Telegram skipped: no BUY/SELL signal", JSON.stringify({
          strategy: result.strategy?.id || result.signal?.strategy || "UNKNOWN",
          decision: result.signal?.decision || "NO_SIGNAL",
          reason: result.signal?.reason || result.reason || "Analysis unavailable"
        }));
        continue;
      }

      await recordSignalForTracking(env, result.signal);

      // sendUniqueSignal provides per-strategy deduplication; it broadcasts only
      // the formatted BUY/SELL signal and suppresses repeated candle alerts.
      const sent = await sendUniqueSignal(env, result.signal);
      broadcasts.push({ strategy: result.signal.strategy, decision: result.signal.decision, ...sent });
    }

    console.log("SIR BOT scheduled signal-only cycle:", JSON.stringify({
      broadcasts,
      checkedAt: new Date().toISOString()
    }));
  } catch (error) {
    // Never send automated error/status messages to Telegram subscribers.
    console.error("SIR BOT scheduled analysis failed:", error.message);
  }
}


// -------------------------
// USER AUTHENTICATION (D1)
// -------------------------
const SESSION_DAYS = 7;
const encoder = new TextEncoder();

function b64url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64url(bytes);
}
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}
async function passwordHash(password, salt = b64url(crypto.getRandomValues(new Uint8Array(16)))) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode(salt), iterations: 10000, hash: "SHA-256" }, key, 256);
  return { salt, hash: b64url(new Uint8Array(bits)) };
}
async function verifyPassword(password, salt, expected) {
  const result = await passwordHash(password, salt);
  return result.hash === expected;
}
async function jsonBody(request) {
  try { return await request.json(); } catch { return {}; }
}
function authResponse(data, status = 200) {
  return response(data, status);
}
async function createSession(env, userId) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(tokenHash, userId, expires).run();
  return { token, expiresAt: expires };
}
async function currentUser(request, env) {
  if (!env.DB) throw new Error("D1 binding DB is missing.");
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`
    SELECT u.id, u.name, u.email, u.status, u.role, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).bind(tokenHash).first();
  if (!row || row.status !== "active" || Date.parse(row.expires_at) <= Date.now()) return null;
  return row;
}
async function requireAdmin(request, env) {
  const user = await currentUser(request, env);
  return user && user.role === "admin" ? user : null;
}
// Multi-user MT5 bridge subsystem. Bridge tokens are stored only as SHA-256 hashes.
async function ensureUserBridgeTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mt5_bridges (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT 'My MT5 terminal', status TEXT NOT NULL DEFAULT 'active',
    symbol TEXT NOT NULL DEFAULT 'XAUUSDm', risk_percent REAL NOT NULL DEFAULT 0.25,
    max_positions INTEGER NOT NULL DEFAULT 5, daily_loss_limit REAL NOT NULL DEFAULT 1,
    execution_enabled INTEGER NOT NULL DEFAULT 0, demo_only INTEGER NOT NULL DEFAULT 1,
    last_seen TEXT, created_at TEXT NOT NULL, revoked_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS mt5_user_signal_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, bridge_id TEXT NOT NULL, user_id TEXT NOT NULL,
    signal_id TEXT NOT NULL, symbol TEXT NOT NULL, timeframe TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('BUY','SELL')), entry REAL NOT NULL,
    stop_loss REAL NOT NULL, tp1 REAL, tp2 REAL, tp3 REAL, confidence REAL,
    setup_score REAL, candle_time TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING', claimed_at TEXT, acknowledged_at TEXT,
    bridge_result TEXT, UNIQUE(bridge_id, signal_id)
  )`).run();
  // Backward-compatible migration for installations created before strategy-aware queues.
  try { await env.DB.prepare(`ALTER TABLE mt5_user_signal_queue ADD COLUMN strategy TEXT NOT NULL DEFAULT 'NORMAL'`).run(); } catch (_) {}
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_mt5_user_queue ON mt5_user_signal_queue(bridge_id,status,expires_at,created_at)`).run();
  // Safety migration: lock every existing and new bridge until separately reviewed.
  await env.DB.prepare(`UPDATE mt5_bridges SET execution_enabled=0, demo_only=1`).run();
}
async function bridgeForRequest(request, env) {
  const token=(request.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'').trim();
  if(!token) return null;
  const row=await env.DB.prepare(`SELECT b.*,u.status AS user_status FROM mt5_bridges b JOIN users u ON u.id=b.user_id WHERE b.token_hash=?`).bind(await sha256(token)).first();
  if(!row || row.status!=='active' || row.user_status!=='active') return null;
  await env.DB.prepare('UPDATE mt5_bridges SET last_seen=? WHERE id=?').bind(new Date().toISOString(),row.id).run();
  return row;
}
async function userBridgeRoutes(request,env,path){
  const user=await currentUser(request,env);
  if(!user) return authResponse({error:'Sign in required.'},401);
  await ensureUserBridgeTables(env);
  if(path==='/mt5/pair' && request.method==='POST'){
    const body=await jsonBody(request); const label=String(body.label||'My MT5 terminal').trim().slice(0,60)||'My MT5 terminal';
    const id=crypto.randomUUID(), token=randomToken(), hash=await sha256(token), now=new Date().toISOString();
    await env.DB.prepare(`INSERT INTO mt5_bridges(id,user_id,token_hash,label,symbol,risk_percent,max_positions,daily_loss_limit,execution_enabled,demo_only,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(id,user.id,hash,label,'XAUUSDm',0.25,5,1,0,1,now).run();
    return authResponse({success:true,bridge:{id,label,status:'active',symbol:'XAUUSDm',riskPercent:0.25,maxPositions:5,dailyLossLimit:1,executionEnabled:false,demoOnly:true},bridgeToken:token,warning:'MT5 execution is enabled for this connection. The local bridge supports verified DEMO and REAL MT5 accounts, detects the connected account mode, and enforces local position and risk limits.'},201);
  }
  if(path==='/mt5/bridges' && request.method==='GET'){
    const rows=await env.DB.prepare(`SELECT id,label,status,symbol,risk_percent,max_positions,daily_loss_limit,execution_enabled,demo_only,last_seen,created_at FROM mt5_bridges WHERE user_id=? ORDER BY created_at DESC`).bind(user.id).all();
    return authResponse({success:true,bridges:rows.results||[]});
  }
  const revoke=path.match(/^\/mt5\/bridges\/([a-f0-9-]+)\/revoke$/i);
  if(revoke && request.method==='POST'){
    const r=await env.DB.prepare(`UPDATE mt5_bridges SET status='revoked',revoked_at=?,execution_enabled=0 WHERE id=? AND user_id=?`).bind(new Date().toISOString(),revoke[1],user.id).run();
    if(!(r.meta?.changes||0)) return authResponse({error:'Bridge not found.'},404);
    await env.DB.prepare(`UPDATE mt5_user_signal_queue SET status='CANCELLED' WHERE bridge_id=? AND status IN ('PENDING','CLAIMED')`).bind(revoke[1]).run();
    return authResponse({success:true,message:'Bridge revoked.'});
  }
  return null;
}
async function userQueueSignal(env,signal){
  await ensureUserBridgeTables(env);
  const rows=await env.DB.prepare(`SELECT b.id,b.user_id FROM mt5_bridges b JOIN users u ON u.id=b.user_id WHERE b.status='active' AND u.status='active'`).all();
  const strategy=String(signal.strategy||'NORMAL').toUpperCase()==='AGGRESSIVE_SCALPER'?'AGGRESSIVE_SCALPER':'NORMAL';
  const now=new Date(), expires=new Date(now.getTime()+5*60*1000), sid=await sha256([strategy,signal.symbol||SYMBOL,signal.timeframe||'M5',signal.candleTime,signal.decision].join('|'));
  let queued=0;
  for(const b of (rows.results||[])){
    const r=await env.DB.prepare(`INSERT INTO mt5_user_signal_queue(bridge_id,user_id,signal_id,symbol,timeframe,decision,entry,stop_loss,tp1,tp2,tp3,confidence,setup_score,candle_time,created_at,expires_at,strategy)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(bridge_id,signal_id) DO NOTHING`).bind(b.id,b.user_id,sid,signal.symbol||SYMBOL,signal.timeframe||'M5',signal.decision,signal.entry,signal.stopLoss,signal.tp1,signal.tp2,signal.tp3,signal.confidence,signal.setupScore,signal.candleTime,now.toISOString(),expires.toISOString(),strategy).run();
    queued+=(r.meta?.changes||0);
  }
  return {queued,bridges:(rows.results||[]).length,signalId:sid};
}
async function mt5BridgeRoutes(request,env,path){
  await ensureUserBridgeTables(env);
  const bridge=await bridgeForRequest(request,env);
  if(!bridge) return response({error:'Invalid, revoked, or inactive bridge token.'},401);
  if(path==='/mt5/next-signal' && request.method==='GET'){
    const now=new Date().toISOString();
    await env.DB.prepare(`UPDATE mt5_user_signal_queue SET status='EXPIRED' WHERE bridge_id=? AND status='PENDING' AND expires_at<=?`).bind(bridge.id,now).run();
    // Reclaim stale leases after 90 seconds if the bridge crashed before acknowledging.
    await env.DB.prepare(`UPDATE mt5_user_signal_queue SET status='PENDING',claimed_at=NULL WHERE bridge_id=? AND status='CLAIMED' AND claimed_at < ?`).bind(bridge.id,new Date(Date.now()-90000).toISOString()).run();
    const row=await env.DB.prepare(`UPDATE mt5_user_signal_queue SET status='CLAIMED',claimed_at=? WHERE id=(SELECT id FROM mt5_user_signal_queue WHERE bridge_id=? AND status='PENDING' AND expires_at>? ORDER BY created_at LIMIT 1) AND status='PENDING' RETURNING *`).bind(now,bridge.id,now).first();
    if(!row) return response({success:true,signal:null,execution:{enabled:false,demoOnly:true}});
    return response({success:true,signal:{signalId:row.signal_id,symbol:row.symbol,timeframe:row.timeframe,strategy:row.strategy||'NORMAL',decision:row.decision,entry:row.entry,stopLoss:row.stop_loss,tp1:row.tp1,tp2:row.tp2,tp3:row.tp3,confidence:row.confidence,setupScore:row.setup_score,candleTime:row.candle_time,expiresAt:row.expires_at},execution:{enabled:Boolean(bridge.execution_enabled),demoOnly:Boolean(bridge.demo_only),symbol:bridge.symbol,riskPercent:bridge.risk_percent,maxPositions:bridge.max_positions,dailyLossLimit:bridge.daily_loss_limit}});
  }
  if(path==='/mt5/ack-signal' && request.method==='POST'){
    const body=await jsonBody(request), sid=String(body.signalId||''), result=String(body.result||'').toUpperCase();
    if(!/^[a-f0-9]{64}$/i.test(sid)||!['RECEIVED','REJECTED','EXECUTED','DUPLICATE'].includes(result)) return response({error:'Invalid signalId or result.'},400);
    const r=await env.DB.prepare(`UPDATE mt5_user_signal_queue SET status='ACKNOWLEDGED',acknowledged_at=?,bridge_result=? WHERE bridge_id=? AND signal_id=? AND status='CLAIMED' RETURNING signal_id`).bind(new Date().toISOString(),result,bridge.id,sid).first();
    if(!r) return response({success:true,idempotent:true,message:'Already acknowledged, expired, or not claimed.'});
    return response({success:true,signalId:sid,result});
  }
  if(path==='/mt5/heartbeat' && request.method==='POST') return response({success:true,bridgeId:bridge.id,serverTime:new Date().toISOString()});
  return response({error:'Bridge route not found.'},404);
}

async function authRoutes(request, env, path) {
  if (!env.DB) return authResponse({ error: "D1 binding DB is not configured." }, 500);

  if (path === "/auth/register" && request.method === "POST") {
    const body = await jsonBody(request);
    const name = String(body.name || "").trim().slice(0, 80);
    const email = String(body.email || "").trim().toLowerCase().slice(0, 190);
    const password = String(body.password || "");
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) {
      return authResponse({ error: "Enter a valid name and email. Password must be at least 10 characters." }, 400);
    }
    const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) return authResponse({ error: "An account with this email already exists." }, 409);
    const id = crypto.randomUUID();
    const h = await passwordHash(password);
    await env.DB.prepare("INSERT INTO users (id,name,email,password_hash,status,role) VALUES (?,?,?,?, 'active','user')")
      .bind(id, name, email, `${h.salt}:${h.hash}`).run();
    return authResponse({ success: true, status: "active", message: "Account created. You can now sign in." }, 201);
  }

  if (path === "/auth/login" && request.method === "POST") {
    const body = await jsonBody(request);
    const usernameOrEmail = String(body.username || body.email || "").trim();
    const password = String(body.password || "");
    if (!usernameOrEmail || !password) return authResponse({ error: "Enter your login details." }, 400);

    // Admin is bootstrapped from Cloudflare secrets, never from public registration.
    if (env.ADMIN_USERNAME && env.ADMIN_PASSWORD &&
        usernameOrEmail.toLowerCase() === String(env.ADMIN_USERNAME).toLowerCase() &&
        password === env.ADMIN_PASSWORD) {
      let admin = await env.DB.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").first();
      if (!admin) {
        const id = crypto.randomUUID();
        const h = await passwordHash(env.ADMIN_PASSWORD);
        await env.DB.prepare("INSERT INTO users (id,name,email,password_hash,status,role) VALUES (?,?,?,?, 'active','admin')")
          .bind(id, "SIR BOT AI Admin", `admin-${id}@sirbot.local`, `${h.salt}:${h.hash}`).run();
        admin = { id };
      } else {
        await env.DB.prepare("UPDATE users SET status='active' WHERE id=?").bind(admin.id).run();
      }
      const session = await createSession(env, admin.id);
      return authResponse({ success: true, token: session.token, expiresAt: session.expiresAt, user: { name: "SIR BOT AI Admin", role: "admin", status: "active" } });
    }

    const user = await env.DB.prepare("SELECT * FROM users WHERE lower(email)=lower(?)").bind(usernameOrEmail).first();
    if (!user) return authResponse({ error: "Invalid login details." }, 401);
    if (user.status === "pending") return authResponse({ error: "ACCOUNT PENDING ACTIVATION. Please wait for admin approval." }, 403);
    if (user.status !== "active") return authResponse({ error: "This account is disabled. Contact customer care." }, 403);
    const [salt, hash] = String(user.password_hash).split(":");
    if (!salt || !hash || !(await verifyPassword(password, salt, hash))) return authResponse({ error: "Invalid login details." }, 401);
    const session = await createSession(env, user.id);
    return authResponse({ success: true, token: session.token, expiresAt: session.expiresAt, user: { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status } });
  }

  if (path === "/auth/me" && request.method === "GET") {
    const user = await currentUser(request, env);
    return user ? authResponse({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status } })
      : authResponse({ error: "Not signed in." }, 401);
  }

  if (path === "/auth/logout" && request.method === "POST") {
    const token = (request.headers.get("Authorization") || "").replace(/^Bearer /, "");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return authResponse({ success: true });
  }

  if (path === "/admin/users" && request.method === "GET") {
    const admin = await requireAdmin(request, env);
    if (!admin) return authResponse({ error: "Admin access required." }, 403);
    const result = await env.DB.prepare("SELECT id,name,email,status,role,created_at,activated_at FROM users ORDER BY created_at DESC").all();
    return authResponse({ success: true, users: result.results || [] });
  }

  if (path === "/admin/mt5/accounts" && request.method === "GET") {
    const admin = await requireAdmin(request, env);
    if (!admin) return authResponse({ error: "Admin access required." }, 403);
    await ensureUserBridgeTables(env);
    const result = await env.DB.prepare(`
      SELECT b.id AS bridge_id, b.user_id, u.name, u.email, u.status AS user_status,
             b.label, b.status AS bridge_status, b.symbol, b.execution_enabled,
             b.demo_only, b.last_seen, b.created_at
      FROM mt5_bridges b JOIN users u ON u.id=b.user_id
      ORDER BY b.created_at DESC
    `).all();
    return authResponse({ success: true, accounts: result.results || [],
      note: "This build reports bridge metadata only. It does not yet collect MT5 balance, equity, positions, or broker credentials." });
  }

  const statusMatch = path.match(/^\/admin\/users\/([^/]+)\/status$/);
  if (statusMatch && request.method === "POST") {
    const admin = await requireAdmin(request, env);
    if (!admin) return authResponse({ error: "Admin access required." }, 403);
    const body = await jsonBody(request);
    const status = String(body.status || "");
    if (!["active", "disabled", "pending"].includes(status)) return authResponse({ error: "Status must be active, disabled, or pending." }, 400);
    const userId = decodeURIComponent(statusMatch[1]);
    const target = await env.DB.prepare("SELECT id,role FROM users WHERE id=?").bind(userId).first();
    if (!target || target.role === "admin") return authResponse({ error: "User not found or cannot modify admin." }, 404);
    await env.DB.prepare("UPDATE users SET status=?, activated_at=CASE WHEN ?='active' THEN CURRENT_TIMESTAMP ELSE activated_at END WHERE id=?")
      .bind(status, status, userId).run();
    if (status !== "active") {
      await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(userId).run();
    }
    return authResponse({ success: true, status });
  }
  return null;
}

// -------------------------
// WORKER
// -------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") return cors();

    try {
      if (path === "/mt5/next-signal" || path === "/mt5/ack-signal" || path === "/mt5/heartbeat") {
        const bridgeResult = await mt5BridgeRoutes(request, env, path);
        if (bridgeResult) return bridgeResult;
      }
      if (path === "/mt5/pair" || path === "/mt5/bridges" || /^\/mt5\/bridges\//.test(path)) {
        const bridgeResult = await userBridgeRoutes(request, env, path);
        if (bridgeResult) return bridgeResult;
      }

      if (path.startsWith("/auth/") || path === "/admin/users" || path.startsWith("/admin/users/")) {
        const authResult = await authRoutes(request, env, path);
        if (authResult) return authResult;
      }

      // Protect private dashboard endpoints. Public health and Telegram/cron remain available.
      const protectedPaths = ["/market-price", "/market-check", "/indicators", "/market-candles", "/performance", "/validation", "/analyze-live", "/analyze-image"];
      if (protectedPaths.includes(path)) {
        const user = await currentUser(request, env);
        if (!user) return response({ error: "Please sign in with an active account." }, 401);
      }

      if (path === "/telegram-webhook") {
        if (request.method !== "POST") return response({ error: "POST method required." }, 405);
        return await telegramWebhook(request, env);
      }

      if (path === "/telegram-set-webhook") {
        if (request.method !== "POST") return response({ error: "POST method required." }, 405);
        if (!authorized(request, env)) return response({ error: "Unauthorized." }, 401);
        return response(await registerTelegramWebhook(env));
      }

      if (path === "/health") {
        return response({
          success: true,
          project: "SIR BOT AI",
          status: "online",
          market: SYMBOL,
          ai: env.TCHAVI_API_KEY ? "configured" : "missing",
          marketData: env.REALMARKETAPI_KEY ? "configured" : "missing",
          telegram: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET ? "configured" : "missing",
          telegramWebhook: env.TELEGRAM_WEBHOOK_SECRET ? "configured" : "missing",
          kv: env.SIGNAL_DEDUPE ? "configured" : "missing",
          trading: "disabled",
          checkedAt: new Date().toISOString()
        });
      }

      if (path === "/market-price") {
        const latest = await getLatestPrice(env, "M5");
        return response({ success: true, ...latest, checkedAt: new Date().toISOString() });
      }

      if (path === "/market-check") {
        const latest = await getLatestPrice(env, "M5");
        const candles = await getCandles(env, "M5");
        return response({
          success: true, symbol: SYMBOL, latestPrice: latest,
          candlesReceived: candles.length, lastCandle: candles.at(-1).time,
          alertsAllowed: latest.fresh
        });
      }

      if (path === "/indicators") {
        const timeframe = url.searchParams.get("timeframe") || "M5";
        if (!TIMEFRAMES.includes(timeframe)) return response({ error: "Use M5, M15, H1, or H4." }, 400);
        const candles = await getCandles(env, timeframe);
        return response({ success: true, timeframe, indicators: indicators(candles) });
      }

      if (path === "/market-candles") {
        const timeframe = url.searchParams.get("timeframe") || "M5";
        if (!TIMEFRAMES.includes(timeframe)) return response({ error: "Use M5, M15, H1, or H4." }, 400);
        const candles = await getCandles(env, timeframe);
        return response({ success: true, symbol: SYMBOL, timeframe, candles });
      }

      if (path === "/performance") {
        const report = await getAccuracyReport(env);
        return response({ success: true, ...report });
      }

      if (path === "/analyze-live") return response(await runAnalysis(env, false, url.searchParams.get("strategy") || "NORMAL"));
      if (path === "/analyze-image") return await analyzeChartImage(request, env);

      if (path === "/analyze-and-notify") {
        if (request.method !== "POST") return response({ error: "POST method required." }, 405);
        if (!authorized(request, env)) return response({ error: "Unauthorized." }, 401);
        return response(await runAnalysis(env, true));
      }

      if (path === "/telegram-test") {
        if (request.method !== "POST") return response({ error: "POST method required." }, 405);
        if (!authorized(request, env)) return response({ error: "Unauthorized." }, 401);
        await sendTelegram(env, "✅ SIR BOT AI Telegram connection test successful.");
        return response({ success: true, message: "Telegram test message sent." });
      }

      return response({
        error: "Route not found.",
        routes: [
          "/health", "/market-price", "/market-check", "/indicators",
          "/market-candles", "/performance", "/analyze-live", "/analyze-and-notify",
          "/telegram-test", "/telegram-webhook", "/telegram-set-webhook",
          "/mt5/next-signal", "/mt5/ack-signal"
        ]
      }, 404);
    } catch (error) {
      console.error("Worker error:", error);
      return response({ success: false, error: error.message }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(scheduledAnalysis(env));
  }
};
