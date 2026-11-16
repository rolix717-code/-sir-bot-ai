const ALLOWED_ORIGIN = "https://rolix717-code.github.io";
const MARKET_BASE = "https://api.realmarketapi.com";
const TCHAVI_URL = "https://tchavi.com/api/v1/chat/completions";

const SYMBOL = "XAUUSD";
const TIMEFRAMES = ["M5", "M15", "H1"];
const MIN_CONFIDENCE = 70;
const SIGNAL_TTL = 86400;

const MAX_M5_AGE_MS = 20 * 60 * 1000;

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
    request.headers.get("Authorization") ===
      `Bearer ${env.TELEGRAM_TEST_SECRET}`
  );
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timestamp(value) {
  if (typeof value === "number") {
    return value < 1e12 ? value * 1000 : value;
  }

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

  const time = timestamp(
    c.OpenTime ??
    c.openTime ??
    c.time ??
    c.timestamp ??
    c.date
  );

  const open = num(c.OpenPrice ?? c.openPrice ?? c.open);
  const high = num(c.HighPrice ?? c.highPrice ?? c.high);
  const low = num(c.LowPrice ?? c.lowPrice ?? c.low);
  const close = num(c.ClosePrice ?? c.closePrice ?? c.close);
  const volume = num(c.Volume ?? c.volume ?? 0);

  if (
    time === null ||
    open === null ||
    high === null ||
    low === null ||
    close === null
  ) {
    return null;
  }

  if (
    high < low ||
    high < open ||
    high < close ||
    low > open ||
    low > close
  ) {
    return null;
  }

  return {
    timestamp: time,
    time: new Date(time).toISOString(),
    open,
    high,
    low,
    close,
    volume: volume ?? 0
  };
}

function normalizeCandles(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : payload?.Data ??
      payload?.data ??
      payload?.items ??
      payload?.candles ??
      [];

  if (!Array.isArray(rows)) {
    throw new Error("Invalid candle response from market API.");
  }

  const unique = new Map();

  for (const row of rows) {
    const candle = normalizeCandle(row);
    if (candle) unique.set(candle.timestamp, candle);
  }

  return [...unique.values()]
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-300);
}

async function marketRequest(env, endpoint, timeframe) {
  if (!env.REALMARKETAPI_KEY) {
    throw new Error("REALMARKETAPI_KEY is missing.");
  }

  const url = new URL(`${MARKET_BASE}/api/v1/${endpoint}`);

  url.searchParams.set("apiKey", env.REALMARKETAPI_KEY);
  url.searchParams.set("symbolCode", SYMBOL);
  url.searchParams.set("timeFrame", timeframe);

  const res = await fetch(url, {
    signal: AbortSignal.timeout(15000)
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `RealMarketAPI ${endpoint} error ${res.status}: ` +
      `${data.Message ?? data.message ?? "Request failed"}`
    );
  }

  return data;
}

// Latest completed candle from /price.
async function getLatestPrice(env, timeframe = "M5") {
  const data = await marketRequest(env, "price", timeframe);

  const candle = normalizeCandle(data);

  if (!candle) {
    throw new Error(
      "Could not read latest price response. Check API response format."
    );
  }

  const ageMs = Date.now() - candle.timestamp;

  return {
    symbol: SYMBOL,
    timeframe,
    price: candle.close,
    candleTime: candle.time,
    timestamp: candle.timestamp,
    ageMinutes: Math.round(ageMs / 60000),
    fresh:
      ageMs >= -120000 &&
      ageMs <= MAX_M5_AGE_MS
  };
}

async function getCandles(env, timeframe) {
  const data = await marketRequest(env, "candle", timeframe);
  const candles = normalizeCandles(data);

  if (candles.length < 50) {
    throw new Error(
      `${timeframe}: only ${candles.length} valid candles received.`
    );
  }

  return candles;
}

// -------------------------
// INDICATORS
// -------------------------

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result =
    values.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) /
      period;

    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) /
      period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];

    ranges.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }

  const recent = ranges.slice(-period);

  return recent.reduce((a, b) => a + b, 0) /
    recent.length;
}

function macd(values) {
  const fast = ema(values, 12);
  const slow = ema(values, 26);

  if (fast === null || slow === null) return null;

  return {
    value: fast - slow
  };
}

function structure(candles) {
  const recent = candles.slice(-20);
  const previous = recent.slice(0, -1);
  const last = recent.at(-1);

  const highest = Math.max(...previous.map(c => c.high));
  const lowest = Math.min(...previous.map(c => c.low));

  let state = "RANGE";

  if (last.close > highest) {
    state = "BULLISH BREAKOUT";
  } else if (last.close < lowest) {
    state = "BEARISH BREAKOUT";
  } else {
    const prev = recent.at(-2);

    if (last.high > prev.high && last.low > prev.low) {
      state = "POSSIBLE BULLISH STRUCTURE";
    } else if (last.high < prev.high && last.low < prev.low) {
      state = "POSSIBLE BEARISH STRUCTURE";
    }
  }

  return {
    state,
    resistance: highest,
    support: lowest
  };
}

function indicators(candles) {
  const closes = candles.map(c => c.close);
  const last = candles.at(-1);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  let trend = "SIDEWAYS";

  if (ema20 !== null && ema50 !== null) {
    if (last.close > ema20 && ema20 > ema50) {
      trend = "BULLISH";
    } else if (last.close < ema20 && ema20 < ema50) {
      trend = "BEARISH";
    }
  }

  return {
    symbol: SYMBOL,
    price: last.close,
    candleTime: last.time,
    trend,
    ema20,
    ema50,
    rsi: rsi(closes),
    atr: atr(candles),
    macd: macd(closes),
    structure: structure(candles)
  };
}

// -------------------------
// AI
// -------------------------

function parseAI(text) {
  if (!text) throw new Error("AI returned an empty response.");

  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("AI did not return valid JSON.");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

function validateAI(data) {
  const decision = String(data.decision ?? "").toUpperCase();
  const trend = String(data.trend ?? "").toUpperCase();
  const confidence = Number(data.confidence);

  if (!["BUY", "SELL", "WAIT"].includes(decision)) {
    throw new Error("Invalid AI decision.");
  }

  if (!["BULLISH", "BEARISH", "SIDEWAYS"].includes(trend)) {
    throw new Error("Invalid AI trend.");
  }

  if (
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 100
  ) {
    throw new Error("Invalid AI confidence.");
  }

  return {
    decision,
    trend,
    confidence,
    reasoning: String(data.reasoning ?? ""),
    risk_warning: String(data.risk_warning ?? "")
  };
}

async function analyzeAI(market, env) {
  if (!env.TCHAVI_API_KEY) {
    throw new Error("TCHAVI_API_KEY is missing.");
  }

  const system = `
You are SIR BOT AI, a cautious XAUUSD market analysis assistant.

Analyze the supplied M5, M15 and H1 data.

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

If the timeframes disagree, data is unclear,
or the setup is weak, choose WAIT.

Confidence is not a guaranteed win probability.
`;

  const res = await fetch(TCHAVI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.TCHAVI_API_KEY}`
    },
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

  if (!res.ok) {
    throw new Error(
      `AI error ${res.status}: ` +
      `${data.error?.message ?? "Request failed"}`
    );
  }

  return validateAI(
    parseAI(data.choices?.[0]?.message?.content)
  );
}

// -------------------------
// SIGNAL
// -------------------------

function makeSignal(analysis, ind) {
  if (analysis.decision === "WAIT") {
    return {
      decision: "WAIT",
      reason: analysis.reasoning
    };
  }

  if (analysis.confidence < MIN_CONFIDENCE) {
    return {
      decision: "WAIT",
      reason: "AI confidence is below the required threshold."
    };
  }

  if (!ind.atr || ind.atr <= 0) {
    return {
      decision: "WAIT",
      reason: "ATR is unavailable."
    };
  }

  if (
    analysis.decision === "BUY" &&
    analysis.trend !== "BULLISH"
  ) {
    return {
      decision: "WAIT",
      reason: "BUY does not match the AI trend."
    };
  }

  if (
    analysis.decision === "SELL" &&
    analysis.trend !== "BEARISH"
  ) {
    return {
      decision: "WAIT",
      reason: "SELL does not match the AI trend."
    };
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
    symbol: SYMBOL,
    timeframe: "M5",
    decision: analysis.decision,
    entry: Number(entry.toFixed(3)),
    stopLoss: Number(sl.toFixed(3)),
    tp1: Number(tp1.toFixed(3)),
    tp2: Number(tp2.toFixed(3)),
    tp3: Number(tp3.toFixed(3)),
    confidence: analysis.confidence,
    trend: analysis.trend,
    candleTime: ind.candleTime,
    reasoning: analysis.reasoning,
    riskWarning: analysis.risk_warning,
    status: "UNEXECUTED"
  };
}

// -------------------------
// TELEGRAM
// -------------------------

async function sendTelegram(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Telegram credentials are missing.");
  }

  const url =
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: message,
      disable_web_page_preview: true
    }),
    signal: AbortSignal.timeout(15000)
  });

  const data = await res.json();

  if (!res.ok || data.ok !== true) {
    throw new Error(
      `Telegram failed: ${data.description ?? res.status}`
    );
  }

  return data;
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
  return [
    "signal",
    signal.symbol,
    signal.timeframe,
    signal.decision,
    signal.candleTime
  ].join(":");
}

async function sendUniqueSignal(env, signal) {
  if (!env.SIGNAL_DEDUPE) {
    throw new Error("SIGNAL_DEDUPE KV binding is missing.");
  }

  const key = signalKey(signal);
  const previous = await env.SIGNAL_DEDUPE.get(key);

  if (previous) {
    return {
      sent: false,
      duplicate: true
    };
  }

  await sendTelegram(env, formatSignal(signal));

  await env.SIGNAL_DEDUPE.put(
    key,
    JSON.stringify({
      sentAt: new Date().toISOString(),
      candleTime: signal.candleTime
    }),
    { expirationTtl: SIGNAL_TTL }
  );

  return {
    sent: true,
    duplicate: false
  };
}

// -------------------------
// MARKET WORKFLOW
// -------------------------

async function collectMarket(env) {
  const result = {};

  for (const tf of TIMEFRAMES) {
    const candles = await getCandles(env, tf);

    result[tf] = {
      candles,
      indicators: indicators(candles)
    };
  }

  return result;
}

function checkFreshness(latestPrice) {
  if (!latestPrice.fresh) {
    return {
      fresh: false,
      reason:
        `Latest completed M5 candle is ${latestPrice.ageMinutes} minutes old.`
    };
  }

  return {
    fresh: true,
    candleTime: latestPrice.candleTime
  };
}

function higherTimeframesAgree(decision, market) {
  const m15 = market.M15.indicators.trend;
  const h1 = market.H1.indicators.trend;

  if (decision === "BUY") {
    return m15 === "BULLISH" && h1 === "BULLISH";
  }

  if (decision === "SELL") {
    return m15 === "BEARISH" && h1 === "BEARISH";
  }

  return false;
}

function aiInput(market) {
  const data = {};

  for (const tf of TIMEFRAMES) {
    data[tf] = {
      indicators: market[tf].indicators,
      candles: market[tf].candles.slice(-100).map(c => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      }))
    };
  }

  return {
    symbol: SYMBOL,
    entryTimeframe: "M5",
    confirmationTimeframes: ["M15", "H1"],
    timeframes: data
  };
}

async function runAnalysis(env, notify = false) {
  // First check the dedicated latest completed M5 candle.
  const latestPrice = await getLatestPrice(env, "M5");

  const freshness = checkFreshness(latestPrice);

  if (!freshness.fresh) {
    return {
      success: false,
      decision: "WAIT",
      reason: freshness.reason,
      latestPrice,
      alertsAllowed: false
    };
  }

  const market = await collectMarket(env);

  // Check that the candle endpoint is not lagging behind /price.
  const m5Candle = market.M5.candles.at(-1);

  if (
    Math.abs(
      m5Candle.timestamp - latestPrice.timestamp
    ) > 10 * 60 * 1000
  ) {
    return {
      success: false,
      decision: "WAIT",
      reason:
        "The /price and /candle endpoints disagree on the latest M5 candle.",
      latestPrice,
      candleTime: m5Candle.time,
      alertsAllowed: false
    };
  }

  const analysis = await analyzeAI(aiInput(market), env);

  let signal = makeSignal(
    analysis,
    market.M5.indicators
  );

  if (
    signal.decision !== "WAIT" &&
    !higherTimeframesAgree(signal.decision, market)
  ) {
    signal = {
      decision: "WAIT",
      reason: "M15 and H1 do not confirm the M5 direction."
    };
  }

  let telegram = {
    sent: false,
    duplicate: false
  };

  if (notify && signal.decision !== "WAIT") {
    telegram = await sendUniqueSignal(env, signal);
  }

  return {
    success: true,
    symbol: SYMBOL,
    latestPrice,
    analysis,
    signal,
    market: {
      M5: market.M5.indicators,
      M15: market.M15.indicators,
      H1: market.H1.indicators
    },
    telegram,
    alertsAllowed: true,
    checkedAt: new Date().toISOString()
  };
}

// -------------------------
// AUTOMATIC CRON
// -------------------------

async function scheduledAnalysis(env) {
  try {
    const result = await runAnalysis(env, true);

    console.log(
      "SIR BOT scheduled result:",
      JSON.stringify({
        success: result.success,
        decision: result.signal?.decision ?? result.decision,
        telegram: result.telegram,
        reason: result.reason ?? result.signal?.reason
      })
    );
  } catch (error) {
    console.error(
      "SIR BOT scheduled analysis failed:",
      error.message
    );
  }
}

// -------------------------
// WORKER
// -------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return cors();
    }

    try {
      if (path === "/health") {
        return response({
          success: true,
          project: "SIR BOT AI",
          status: "online",
          market: SYMBOL,
          ai: env.TCHAVI_API_KEY ? "configured" : "missing",
          marketData: env.REALMARKETAPI_KEY ? "configured" : "missing",
          telegram:
            env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
              ? "configured"
              : "missing",
          kv: env.SIGNAL_DEDUPE ? "configured" : "missing",
          trading: "disabled",
          checkedAt: new Date().toISOString()
        });
      }

      if (path === "/market-price") {
        const latest = await getLatestPrice(env, "M5");

        return response({
          success: true,
          ...latest,
          checkedAt: new Date().toISOString()
        });
      }

      if (path === "/market-check") {
        const latest = await getLatestPrice(env, "M5");
        const candles = await getCandles(env, "M5");

        return response({
          success: true,
          symbol: SYMBOL,
          latestPrice: latest,
          candlesReceived: candles.length,
          lastCandle: candles.at(-1).time,
          alertsAllowed: latest.fresh
        });
      }

      if (path === "/indicators") {
        const timeframe =
          url.searchParams.get("timeframe") || "M5";

        if (!TIMEFRAMES.includes(timeframe)) {
          return response(
            { error: "Use M5, M15, or H1." },
            400
          );
        }

        const candles = await getCandles(env, timeframe);

        return response({
          success: true,
          timeframe,
          indicators: indicators(candles)
        });
      }

      if (path === "/market-candles") {
        const timeframe =
          url.searchParams.get("timeframe") || "M5";

        if (!TIMEFRAMES.includes(timeframe)) {
          return response(
            { error: "Use M5, M15, or H1." },
            400
          );
        }

        const candles = await getCandles(env, timeframe);

        return response({
          success: true,
          symbol: SYMBOL,
          timeframe,
          candles
        });
      }

      if (path === "/analyze-live") {
        return response(await runAnalysis(env, false));
      }

      if (path === "/analyze-and-notify") {
        if (request.method !== "POST") {
          return response(
            { error: "POST method required." },
            405
          );
        }

        if (!authorized(request, env)) {
          return response(
            { error: "Unauthorized." },
            401
          );
        }

        return response(await runAnalysis(env, true));
      }

      if (path === "/telegram-test") {
        if (request.method !== "POST") {
          return response(
            { error: "POST method required." },
            405
          );
        }

        if (!authorized(request, env)) {
          return response(
            { error: "Unauthorized." },
            401
          );
        }

        await sendTelegram(
          env,
          "✅ SIR BOT AI Telegram connection test successful."
        );

        return response({
          success: true,
          message: "Telegram test message sent."
        });
      }

      return response(
        {
          error: "Route not found.",
          routes: [
            "/health",
            "/market-price",
            "/market-check",
            "/indicators",
            "/market-candles",
            "/analyze-live",
            "/analyze-and-notify",
            "/telegram-test"
          ]
        },
        404
      );
    } catch (error) {
      console.error("Worker error:", error);

      return response({
        success: false,
        error: error.message
      }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(scheduledAnalysis(env));
  }
};
