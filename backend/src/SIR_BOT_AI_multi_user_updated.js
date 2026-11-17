const ALLOWED_ORIGIN = "https://rolix717-code.github.io";
const MARKET_BASE = "https://api.realmarketapi.com";
const TCHAVI_URL = "https://tchavi.com/api/v1/chat/completions";

const SYMBOL = "XAUUSD";
const TIMEFRAMES = ["M5", "M15", "H1", "H4"];
const A_PLUS_MIN_SCORE = 70;
const MIN_CONFIDENCE = 65;
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
  const frames = ["H4", "H1", "M15", "M5"];
  const trends = Object.fromEntries(frames.map(tf => [tf, market[tf].indicators.trend]));
  const priceAction = Object.fromEntries(frames.map(tf => [tf, advancedPriceAction(market[tf].candles)]));
  const m5 = market.M5.indicators;
  const m15 = market.M15.indicators;
  const h1 = market.H1.indicators;
  const h4 = market.H4.indicators;

  function score(direction) {
    let points = 0;
    const reasons = [];
    const opposite = direction === "BUY" ? "BEARISH" : "BULLISH";
    const aligned = frames.filter(tf => trends[tf] === (direction === "BUY" ? "BULLISH" : "BEARISH")).length;
    points += aligned * 12.5;
    reasons.push(`${aligned}/4 timeframe trends aligned`);

    const rsiGood = direction === "BUY" ? m5.rsi >= 50 && m5.rsi <= 72 : m5.rsi <= 50 && m5.rsi >= 28;
    if (rsiGood) { points += 10; reasons.push("M5 RSI supports momentum"); }
    else reasons.push("M5 RSI is not in preferred momentum range");

    const macdGood = direction === "BUY" ? m5.macd?.value > 0 : m5.macd?.value < 0;
    if (macdGood) { points += 8; reasons.push("M5 MACD confirms direction"); }

    const pa = priceAction.M5;
    const sweepGood = direction === "BUY" ? pa.liquiditySweep === "BULLISH_SWEEP" : pa.liquiditySweep === "BEARISH_SWEEP";
    const bosGood = direction === "BUY" ? pa.structureBreak === "BULLISH_BOS" : pa.structureBreak === "BEARISH_BOS";
    const fvgGood = direction === "BUY" ? pa.fairValueGap === "BULLISH_FVG" : pa.fairValueGap === "BEARISH_FVG";
    if (sweepGood) { points += 15; reasons.push("M5 liquidity sweep detected"); }
    if (bosGood) { points += 15; reasons.push("M5 break of structure detected"); }
    if (fvgGood) { points += 8; reasons.push("M5 fair value gap detected"); }

    const correctZone = direction === "BUY" ? pa.zone === "DISCOUNT" : pa.zone === "PREMIUM";
    if (correctZone) { points += 8; reasons.push(`Price is in ${pa.zone.toLowerCase()} zone`); }

    const volatilityOk = m5.atr && m5.atr > 0 && pa.candleRange <= m5.atr * 2.5;
    if (volatilityOk) { points += 5; reasons.push("Volatility is within filter"); }

    const higherConflicts = [h4, h1, m15].filter(
      x => x.trend === opposite
    ).length;

    const higherConflict = higherConflicts >= 2;

    if (higherConflict) {
      points -= 20;
      reasons.push("Multiple higher-timeframe conflicts");
    }
    return { score: Math.max(0, Math.min(100, Math.round(points))), reasons, aligned, higherConflict };
  }

  const buy = score("BUY");
  const sell = score("SELL");
  const selected = buy.score >= sell.score ? { decision: "BUY", ...buy } : { decision: "SELL", ...sell };
  return { trends, priceAction, buy, sell, ...selected, threshold: A_PLUS_MIN_SCORE };
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

async function analyzeAI(market, env) {
  if (!env.TCHAVI_API_KEY) throw new Error("TCHAVI_API_KEY is missing.");

  const system = `
You are SIR BOT AI, a cautious XAUUSD market analysis assistant.
Analyze the supplied H4, H1, M15 and M5 data. H4 is the directional context; M5 is the entry timeframe.
Consider:
- Multi-timeframe trend alignment
- EMA structure
- RSI
- MACD
- ATR volatility
- Support and resistance
- Market structure
- Possible liquidity sweeps and breakouts
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
A valid BUY or SELL setup may be considered when at least 2 of the 3 confirmation timeframes (M15, H1, H4) agree.

Do not automatically choose WAIT because one timeframe disagrees.

Consider valid pullbacks, breakouts, liquidity sweeps and reversals.

Choose WAIT when the setup is genuinely weak, market data is unreliable, or the indicators provide insufficient directional evidence.

Do not fabricate confidence scores. The deterministic intelligence score is a separate gate; only setups scoring at least 70/100 can become trade signals.

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

function makeSignal(analysis, ind) {
  if (analysis.decision === "WAIT") return { decision: "WAIT", reason: analysis.reasoning };
  if (analysis.confidence < MIN_CONFIDENCE) return { decision: "WAIT", reason: "AI confidence is below the required threshold." };
  if (!Number.isFinite(analysis.setupScore) || analysis.setupScore < A_PLUS_MIN_SCORE) {
    return { decision: "WAIT", reason: `A+ filter not met. Deterministic setup score: ${analysis.setupScore ?? "N/A"}/100; minimum required: ${A_PLUS_MIN_SCORE}.` };
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
    symbol: SYMBOL, timeframe: "M5", decision: analysis.decision,
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
🏆 A+ SETUP SCORE: ${signal.setupScore ?? "N/A"}/100
🕒 CANDLE: ${signal.candleTime}
📝 ANALYSIS:
${signal.reasoning}
⚠️ RISK:
${signal.riskWarning || "Trading involves risk."}
━━━━━━━━━━━━━━━━━━
STATUS: ANALYSIS ONLY
MT5 EXECUTION: DISABLED
SIR BOT AI
`.trim();
}

// -------------------------
// DUPLICATE PROTECTION
// -------------------------

function signalKey(signal) {
  return ["signal", signal.symbol, signal.timeframe, signal.decision, signal.candleTime].join(":");
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
  const id = `${signal.candleTime}:${signal.decision}`;
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
  if (!pending.length) return { checked: 0, resolved: [] };

  const candles = await getCandles(env, "M5");
  const resolved = [];

  for (const record of pending) {
    const laterCandles = candles.filter(c => c.timestamp > record.entryTimestamp);
    let result = null;

    for (const candle of laterCandles) {
      const isBuy = record.decision === "BUY";
      const stopHit = isBuy ? candle.low <= record.stopLoss : candle.high >= record.stopLoss;
      const targetHit = isBuy ? candle.high >= record.takeProfit : candle.low <= record.takeProfit;

      if (stopHit && targetHit) {
        // If both levels occur inside one M5 candle, their order is unknowable.
        // Count it conservatively as a loss rather than assuming TP was first.
        result = { outcome: "LOSS", exitPrice: record.stopLoss, reason: "SL and TP1 touched in the same candle; counted conservatively as SL." };
      } else if (stopHit) {
        result = { outcome: "LOSS", exitPrice: record.stopLoss, reason: "Stop loss reached." };
      } else if (targetHit) {
        result = { outcome: "WIN", exitPrice: record.takeProfit, reason: "TP1 reached." };
      }

      if (result) {
        record.status = "RESOLVED";
        record.outcome = result.outcome;
        record.exitPrice = result.exitPrice;
        record.resolutionReason = result.reason;
        record.resolutionCandle = candle.time;
        record.resolvedAt = new Date().toISOString();

        const key = ACCURACY_PREFIX + encodeURIComponent(record.id);
        await env.SIGNAL_DEDUPE.put(key, JSON.stringify(record), { expirationTtl: ACCURACY_TTL });
        resolved.push(record);
        break;
      }
    }
  }

  return { checked: pending.length, resolved };
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
🎯 TP1 hit rate: ${rate}
━━━━━━━━━━━━━━━━━━
Method: first TP1 or SL touched on later M5 candles.
If both are touched in one candle, it is counted as an SL.
This is historical signal tracking, not guaranteed future performance.
MT5 execution: DISABLED
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
  const requiredTrend = decision === "BUY" ? "BULLISH" : "BEARISH";

  const trends = [
    market.M15.indicators.trend,
    market.H1.indicators.trend,
    market.H4.indicators.trend
  ];

  const confirmations = trends.filter(
    trend => trend === requiredTrend
  ).length;

  return confirmations >= 2;
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

async function runAnalysis(env, notify = false) {
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
  const analysis = await analyzeAI({ ...aiInput(market), deterministicIntelligence: intelligence }, env);
  analysis.setupScore = intelligence.score;
  analysis.setupDirection = intelligence.decision;
  analysis.intelligenceReasons = intelligence.reasons;
  let signal = makeSignal(analysis, market.M5.indicators);

  if (signal.decision !== "WAIT" && !higherTimeframesAgree(signal.decision, market)) {
    signal = { decision: "WAIT", reason: "M15 and H1 do not confirm the M5 direction." };
  }

  let telegram = { sent: false, duplicate: false };
  if (notify && signal.decision !== "WAIT") telegram = await sendUniqueSignal(env, signal);

  return {
    success: true,
    symbol: SYMBOL,
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
MT5 execution: DISABLED
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
MT5 execution: DISABLED
SIR BOT AI
`.trim());
    return;
  }

  if (command === "/signal") {
    await sendTelegramToChat(env, chatId, "⏳ SIR BOT AI is analyzing XAUUSD across M5, M15 and H1. Please wait...");
    try {
      const result = await runAnalysis(env, false);
      if (!result.success) {
        await sendTelegramToChat(env, chatId, `
🟡 SIR BOT AI — XAUUSD
DECISION: WAIT
Reason:
${result.reason ?? "Market data is not ready."}
No signal has been issued.
MT5 execution: DISABLED
`.trim());
        return;
      }

      if (result.signal.decision === "WAIT") {
        await sendTelegramToChat(env, chatId, `
🟡 SIR BOT AI — XAUUSD
DECISION: WAIT
Latest price: ${result.latestPrice.price}
AI decision: ${result.analysis.decision}
AI score: ${result.analysis.confidence}/100
Reason:
${result.signal.reason ?? result.analysis.reasoning}
Risk:
${result.analysis.risk_warning || "Trading involves risk."}
No trade signal issued.
MT5 execution: DISABLED
`.trim());
        return;
      }

      await sendTelegramToChat(env, chatId, formatSignal(result.signal));
    } catch (error) {
      console.error("Telegram signal command error:", error);
      await sendTelegramToChat(env, chatId, `⚠️ SIR BOT AI could not complete the analysis.\n\nReason: ${error.message}`);
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

function formatScheduledReport(result) {
  const checkedAt = kampalaTime();

  if (!result.success) {
    return `
🟡 SIR BOT AI — XAUUSD
⏱ AUTOMATIC 5-MINUTE REPORT
━━━━━━━━━━━━━━━━━━
📊 DECISION: WAIT
${result.latestPrice?.price != null ? `📍 LATEST PRICE: ${result.latestPrice.price}` : ""}
${result.latestPrice?.candleTime ? `🕒 CANDLE: ${result.latestPrice.candleTime}` : ""}
⚠️ MARKET DATA:
${result.reason || "Market data is not ready. No trade signal issued."}
━━━━━━━━━━━━━━━━━━
No BUY or SELL signal issued.
MT5 EXECUTION: DISABLED
🕒 Kampala time: ${checkedAt}
SIR BOT AI
`.trim();
  }

  const signal = result.signal;
  const analysis = result.analysis;
  const market = result.market || {};
  const trendLine = [
    `M5: ${market.M5?.trend || "N/A"}`,
    `M15: ${market.M15?.trend || "N/A"}`,
    `H1: ${market.H1?.trend || "N/A"}`,
    `H4: ${market.H4?.trend || "N/A"}`
  ].join(" | ");

  if (signal?.decision === "BUY" || signal?.decision === "SELL") {
    return `
${formatSignal(signal)}
━━━━━━━━━━━━━━━━━━
📊 MULTI-TIMEFRAME:
${trendLine}
⏱ AUTOMATIC 5-MINUTE REPORT
🕒 Kampala time: ${checkedAt}
`.trim();
  }

  return `
🟡 SIR BOT AI — XAUUSD
⏱ AUTOMATIC 5-MINUTE REPORT
━━━━━━━━━━━━━━━━━━
📊 DECISION: WAIT
📍 LATEST PRICE: ${result.latestPrice?.price ?? "N/A"}
🧠 AI ORIGINAL DECISION: ${analysis?.decision ?? "N/A"}
📈 AI TREND: ${analysis?.trend ?? "N/A"}
🧠 AI SCORE: ${analysis?.confidence ?? "N/A"}/100
🏆 A+ SETUP SCORE: ${analysis?.setupScore ?? "N/A"}/100
📊 MULTI-TIMEFRAME:
${trendLine}
━━━━━━━━━━━━━━━━━━
📝 REASON:
${signal?.reason || analysis?.reasoning || "No clear trading setup."}
⚠️ RISK:
${analysis?.risk_warning || "Trading involves risk. Wait for a clear setup."}
━━━━━━━━━━━━━━━━━━
NO TRADE SIGNAL ISSUED.
MT5 EXECUTION: DISABLED
🕒 Kampala time: ${checkedAt}
SIR BOT AI
`.trim();
}

async function scheduledAnalysis(env) {
  try {
    // Do not use runAnalysis(env, true) here: that sends only BUY/SELL.
    // This scheduled path sends a Telegram report for BUY, SELL, and WAIT.
    const tracking = await monitorPendingSignals(env);
    for (const resolved of tracking.resolved) {
      await sendTelegram(env, `
📊 SIR BOT AI — SIGNAL RESULT
${resolved.decision} ${resolved.symbol}
Outcome: ${resolved.outcome}
Entry: ${resolved.entry}
Exit: ${resolved.exitPrice}
${resolved.resolutionReason}
Entry candle: ${resolved.candleTime}
Resolved candle: ${resolved.resolutionCandle}
MT5 execution: DISABLED
`.trim());
    }

    const result = await runAnalysis(env, false);
    if (result.success && result.signal && ["BUY", "SELL"].includes(result.signal.decision)) {
      await recordSignalForTracking(env, result.signal);
    }
    const message = formatScheduledReport(result);
    await sendTelegram(env, message);

    console.log("SIR BOT scheduled Telegram report sent:", JSON.stringify({
      success: result.success,
      decision: result.signal?.decision ?? result.decision,
      trackedSignalsChecked: tracking.checked,
      trackedSignalsResolved: tracking.resolved.length,
      checkedAt: result.checkedAt ?? new Date().toISOString()
    }));
  } catch (error) {
    console.error("SIR BOT scheduled analysis failed:", error.message);
    try {
      await sendTelegram(env, `
⚠️ SIR BOT AI — SYSTEM ALERT
The automatic 5-minute analysis could not be completed.
Reason: ${error.message}
No trade signal issued.
MT5 EXECUTION: DISABLED
🕒 Kampala time: ${kampalaTime()}
SIR BOT AI
`.trim());
    } catch (telegramError) {
      console.error("Could not send scheduled error report:", telegramError.message);
    }
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
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode(salt), iterations: 120000, hash: "SHA-256" }, key, 256);
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
    await env.DB.prepare("INSERT INTO users (id,name,email,password_hash,status,role) VALUES (?,?,?,?, 'pending','user')")
      .bind(id, name, email, `${h.salt}:${h.hash}`).run();
    return authResponse({ success: true, status: "pending", message: "Registration received. Your account is waiting for admin activation." }, 201);
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
      if (path.startsWith("/auth/") || path === "/admin/users" || path.startsWith("/admin/users/")) {
        const authResult = await authRoutes(request, env, path);
        if (authResult) return authResult;
      }

      // Protect private dashboard endpoints. Public health and Telegram/cron remain available.
      const protectedPaths = ["/market-price", "/market-check", "/indicators", "/market-candles", "/performance", "/validation", "/analyze-live"];
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

      if (path === "/analyze-live") return response(await runAnalysis(env, false));

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
          "/telegram-test", "/telegram-webhook", "/telegram-set-webhook"
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
