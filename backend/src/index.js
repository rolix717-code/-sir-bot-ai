const ALLOWED_ORIGIN = "https://rolix717-code.github.io";

const TCHAVI_URL =
  "https://tchavi.com/api/v1/chat/completions";

const MARKET_BASE_URL =
  "https://api.realmarketapi.com";

const SYMBOL = "XAUUSD";
const TIMEFRAMES = ["M5", "M15", "H1"];

const AI_MODEL = "gpt-4o-mini";

const MIN_CONFIDENCE = 70;
const SIGNAL_TTL_SECONDS = 60 * 60 * 24;

const TIMEFRAME_MS = {
  M5: 5 * 60 * 1000,
  M15: 15 * 60 * 1000,
  H1: 60 * 60 * 1000
};

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization"
    }
  });
}

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization"
    }
  });
}

function authorized(request, env) {
  const expected = env.TELEGRAM_TEST_SECRET;

  if (!expected) return false;

  return (
    request.headers.get("Authorization") ===
    `Bearer ${expected}`
  );
}

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function getTimestamp(value) {
  if (typeof value === "number") {
    return value < 1000000000000
      ? value * 1000
      : value;
  }

  if (typeof value === "string") {
    if (/^\d+$/.test(value)) {
      const numeric = Number(value);

      return numeric < 1000000000000
        ? numeric * 1000
        : numeric;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeCandle(candle) {
  const time =
    candle.OpenTime ??
    candle.openTime ??
    candle.time ??
    candle.timestamp ??
    candle.date;

  const open = number(
    candle.OpenPrice ?? candle.openPrice ?? candle.open
  );

  const high = number(
    candle.HighPrice ?? candle.highPrice ?? candle.high
  );

  const low = number(
    candle.LowPrice ?? candle.lowPrice ?? candle.low
  );

  const close = number(
    candle.ClosePrice ?? candle.closePrice ?? candle.close
  );

  const volume = number(
    candle.Volume ?? candle.volume ?? 0
  );

  const timestamp = getTimestamp(time);

  if (
    timestamp === null ||
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
    time: new Date(timestamp).toISOString(),
    timestamp,
    open,
    high,
    low,
    close,
    volume: volume ?? 0
  };
}

function normalizeCandles(payload) {
  const rows =
    Array.isArray(payload)
      ? payload
      : payload?.Data ??
        payload?.data ??
        payload?.items ??
        payload?.candles ??
        [];

  if (!Array.isArray(rows)) {
    throw new Error("Market API returned invalid candle data.");
  }

  const candles = rows
    .map(normalizeCandle)
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);

  const unique = new Map();

  for (const candle of candles) {
    unique.set(candle.timestamp, candle);
  }

  return [...unique.values()].slice(-300);
}

async function getCandles(env, timeframe) {
  if (!env.REALMARKETAPI_KEY) {
    throw new Error("REALMARKETAPI_KEY is not configured.");
  }

  const url = new URL(
    `${MARKET_BASE_URL}/api/v1/candle`
  );

  url.searchParams.set("apiKey", env.REALMARKETAPI_KEY);
  url.searchParams.set("symbolCode", SYMBOL);
  url.searchParams.set("timeFrame", timeframe);

  const result = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(15000)
  });

  const payload = await result.json();

  if (!result.ok) {
    throw new Error(
      `Market API error ${result.status}: ` +
      `${payload.Message ?? payload.message ?? "Unknown error"}`
    );
  }

  const candles = normalizeCandles(payload);

  if (candles.length < 50) {
    throw new Error(
      `${timeframe}: only ${candles.length} valid candles received.`
    );
  }

  return candles;
}

// ------------------------------
// TECHNICAL INDICATORS
// ------------------------------

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    averageGain =
      (averageGain * (period - 1) +
        Math.max(change, 0)) / period;

    averageLoss =
      (averageLoss * (period - 1) +
        Math.max(-change, 0)) / period;
  }

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

function calculateATR(candles, period = 14) {
  if (candles.length <= period) return null;

  const ranges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    ranges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  const recent = ranges.slice(-period);

  return recent.reduce((sum, value) => sum + value, 0) /
    recent.length;
}

function calculateMACD(values) {
  if (values.length < 35) return null;

  const fast = ema(values, 12);
  const slow = ema(values, 26);

  if (fast === null || slow === null) return null;

  return {
    macd: fast - slow,
    signal: null
  };
}

function marketStructure(candles) {
  const recent = candles.slice(-20);

  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);

  const latest = recent[recent.length - 1];
  const previous = recent[recent.length - 2];

  const highest = Math.max(...highs.slice(0, -1));
  const lowest = Math.min(...lows.slice(0, -1));

  let structure = "RANGE";

  if (latest.close > highest) {
    structure = "BULLISH BREAKOUT";
  } else if (latest.close < lowest) {
    structure = "BEARISH BREAKOUT";
  } else if (
    latest.high > previous.high &&
    latest.low > previous.low
  ) {
    structure = "POSSIBLE BULLISH STRUCTURE";
  } else if (
    latest.high < previous.high &&
    latest.low < previous.low
  ) {
    structure = "POSSIBLE BEARISH STRUCTURE";
  }

  return {
    structure,
    resistance: highest,
    support: lowest
  };
}

function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);

  const latest = candles[candles.length - 1];

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);

  const rsi = calculateRSI(closes);
  const atr = calculateATR(candles);
  const macd = calculateMACD(closes);

  const structure = marketStructure(candles);

  let trend = "SIDEWAYS";

  if (
    ema20 !== null &&
    ema50 !== null &&
    latest.close > ema20 &&
    ema20 > ema50
  ) {
    trend = "BULLISH";
  } else if (
    ema20 !== null &&
    ema50 !== null &&
    latest.close < ema20 &&
    ema20 < ema50
  ) {
    trend = "BEARISH";
  }

  return {
    symbol: SYMBOL,
    price: latest.close,
    candleTime: latest.time,
    trend,
    ema20,
    ema50,
    rsi,
    atr,
    macd,
    structure
  };
}

// ------------------------------
// AI ANALYSIS
// ------------------------------

function extractAIJSON(text) {
  if (!text) {
    throw new Error("AI returned an empty response.");
  }

  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI response did not contain valid JSON.");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

function validateAIAnalysis(data) {
  const decision = String(data.decision ?? "").toUpperCase();

  const trend = String(data.trend ?? "").toUpperCase();

  const confidence = Number(data.confidence);

  if (!["BUY", "SELL", "WAIT"].includes(decision)) {
    throw new Error("AI returned an invalid decision.");
  }

  if (!["BULLISH", "BEARISH", "SIDEWAYS"].includes(trend)) {
    throw new Error("AI returned an invalid trend.");
  }

  if (
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 100
  ) {
    throw new Error("AI returned an invalid confidence value.");
  }

  return {
    decision,
    trend,
    confidence,
    reasoning: String(data.reasoning ?? ""),
    risk_warning: String(data.risk_warning ?? "")
  };
}

async function analyzeWithAI(marketData, env) {
  if (!env.TCHAVI_API_KEY) {
    throw new Error("TCHAVI_API_KEY is not configured.");
  }

  const systemPrompt = `
You are SIR BOT AI, a cautious XAUUSD market analysis system.

Analyze the supplied technical indicators and multi-timeframe data.

Use:
- Multi-timeframe trend alignment
- EMA structure
- RSI momentum
- MACD momentum
- ATR volatility
- Support and resistance
- Market structure
- Possible liquidity sweeps and breakouts

Do not invent market prices or indicators.

Return ONLY valid JSON in this format:

{
  "decision": "BUY",
  "trend": "BULLISH",
  "confidence": 75,
  "reasoning": "Brief explanation",
  "risk_warning": "Brief risk warning"
}

Decision must be BUY, SELL, or WAIT.
Trend must be BULLISH, BEARISH, or SIDEWAYS.
Confidence must be a number from 0 to 100.

If timeframes disagree, data is unclear, or the setup is weak,
return WAIT.

Do not claim that confidence is a guaranteed win probability.
`;

  const result = await fetch(TCHAVI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.TCHAVI_API_KEY}`
    },
    body: JSON.stringify({
      model: AI_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: systemPrompt
        },
        {
          role: "user",
          content: JSON.stringify(marketData)
        }
      ]
    }),
    signal: AbortSignal.timeout(30000)
  });

  const payload = await result.json();

  if (!result.ok) {
    throw new Error(
      `AI provider error ${result.status}: ` +
      `${payload.error?.message ?? "Unknown error"}`
    );
  }

  const content =
    payload.choices?.[0]?.message?.content;

  const parsed = extractAIJSON(content);

  return validateAIAnalysis(parsed);
}

// ------------------------------
// SIGNAL CALCULATION
// ------------------------------

function calculateSignal(analysis, indicators, timeframe = "M5") {
  const decision = analysis.decision;

  if (decision === "WAIT") {
    return {
      decision: "WAIT",
      reason: analysis.reasoning
    };
  }

  if (analysis.confidence < MIN_CONFIDENCE) {
    return {
      decision: "WAIT",
      reason: "Confidence is below the minimum threshold."
    };
  }

  if (!indicators.atr || indicators.atr <= 0) {
    return {
      decision: "WAIT",
      reason: "ATR data is unavailable."
    };
  }

  if (
    decision === "BUY" &&
    analysis.trend !== "BULLISH"
  ) {
    return {
      decision: "WAIT",
      reason: "BUY direction does not match the AI trend."
    };
  }

  if (
    decision === "SELL" &&
    analysis.trend !== "BEARISH"
  ) {
    return {
      decision: "WAIT",
      reason: "SELL direction does not match the AI trend."
    };
  }

  const entry = indicators.price;
  const distance = indicators.atr * 1.5;

  let stopLoss;
  let tp1;
  let tp2;
  let tp3;

  if (decision === "BUY") {
    stopLoss = entry - distance;
    tp1 = entry + distance;
    tp2 = entry + distance * 2;
    tp3 = entry + distance * 3;
  } else {
    stopLoss = entry + distance;
    tp1 = entry - distance;
    tp2 = entry - distance * 2;
    tp3 = entry - distance * 3;
  }

  return {
    decision,
    symbol: SYMBOL,
    timeframe,
    entry: Number(entry.toFixed(3)),
    stopLoss: Number(stopLoss.toFixed(3)),
    tp1: Number(tp1.toFixed(3)),
    tp2: Number(tp2.toFixed(3)),
    tp3: Number(tp3.toFixed(3)),
    confidence: analysis.confidence,
    trend: analysis.trend,
    status: "UNEXECUTED",
    candleTime: indicators.candleTime,
    reasoning: analysis.reasoning,
    riskWarning: analysis.risk_warning
  };
}

// ------------------------------
// MULTI-TIMEFRAME ANALYSIS
// ------------------------------

async function collectMarketData(env) {
  const results = {};

  for (const timeframe of TIMEFRAMES) {
    const candles = await getCandles(env, timeframe);

    results[timeframe] = {
      candles,
      indicators: calculateIndicators(candles)
    };
  }

  return results;
}

function checkFreshness(marketData) {
  const latest = marketData.M5?.candles?.at(-1);

  if (!latest) {
    return {
      fresh: false,
      reason: "No M5 candle available."
    };
  }

  const age = Date.now() - latest.timestamp;

  // Allow up to 20 minutes for a delayed M5 feed.
  // Signals are skipped if the latest candle is older.
  if (age > 20 * 60 * 1000) {
    return {
      fresh: false,
      reason:
        `Latest M5 candle is ${Math.round(age / 60000)} minutes old.`
    };
  }

  if (age < -2 * 60 * 1000) {
    return {
      fresh: false,
      reason: "Market candle timestamp is unexpectedly in the future."
    };
  }

  return {
    fresh: true,
    candleTime: latest.time
  };
}

function buildAnalysisInput(marketData) {
  const result = {};

  for (const timeframe of TIMEFRAMES) {
    const item = marketData[timeframe];

    result[timeframe] = {
      indicators: item.indicators,
      recentCandles: item.candles.slice(-100).map(c => ({
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
    higherTimeframes: ["M15", "H1"],
    data: result
  };
}

function alignedWithHigherTimeframes(decision, marketData) {
  const m15 = marketData.M15.indicators.trend;
  const h1 = marketData.H1.indicators.trend;

  if (decision === "BUY") {
    return m15 === "BULLISH" && h1 === "BULLISH";
  }

  if (decision === "SELL") {
    return m15 === "BEARISH" && h1 === "BEARISH";
  }

  return false;
}

// ------------------------------
// TELEGRAM
// ------------------------------

async function sendTelegram(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Telegram credentials are not configured.");
  }

  const url =
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const result = await fetch(url, {
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

  const payload = await result.json();

  if (!result.ok || payload.ok !== true) {
    throw new Error(
      `Telegram delivery failed: ${payload.description ?? result.status}`
    );
  }

  return payload;
}

function formatSignalMessage(signal) {
  return `
🟡 SIR BOT AI — XAUUSD

📊 SIGNAL: ${signal.decision}
⏱ TIMEFRAME: ${signal.timeframe}

━━━━━━━━━━━━━━━━━━

📍 ENTRY: ${signal.entry}
🛑 STOP LOSS: ${signal.stopLoss}

🎯 TAKE PROFIT 1: ${signal.tp1}
🎯 TAKE PROFIT 2: ${signal.tp2}
🎯 TAKE PROFIT 3: ${signal.tp3}

━━━━━━━━━━━━━━━━━━

📈 TREND: ${signal.trend}
🧠 AI SCORE: ${signal.confidence}/100

🕒 CANDLE: ${signal.candleTime}

📝 ANALYSIS:
${signal.reasoning}

⚠️ RISK WARNING:
${signal.riskWarning || "Trading involves risk."}

━━━━━━━━━━━━━━━━━━

STATUS: ANALYSIS ONLY
MT5 EXECUTION: DISABLED

SIR BOT AI
`.trim();
}

// ------------------------------
// DUPLICATE PROTECTION
// ------------------------------

function makeSignalKey(signal) {
  const raw =
    `${signal.symbol}:${signal.timeframe}:` +
    `${signal.decision}:${signal.candleTime}`;

  return `signal:${raw}`;
}

async function alreadySent(env, key) {
  if (!env.SIGNAL_DEDUPE) {
    throw new Error("SIGNAL_DEDUPE KV binding is missing.");
  }

  const existing = await env.SIGNAL_DEDUPE.get(key);

  return existing !== null;
}

async function markSent(env, key, signal) {
  await env.SIGNAL_DEDUPE.put(
    key,
    JSON.stringify({
      decision: signal.decision,
      candleTime: signal.candleTime,
      sentAt: new Date().toISOString()
    }),
    {
      expirationTtl: SIGNAL_TTL_SECONDS
    }
  );
}

// ------------------------------
// MAIN ANALYSIS WORKFLOW
// ------------------------------

async function runAnalysis(env, sendAlert = false) {
  const marketData = await collectMarketData(env);

  const freshness = checkFreshness(marketData);

  if (!freshness.fresh) {
    return {
      success: false,
      decision: "WAIT",
      reason: freshness.reason
    };
  }

  const aiInput = buildAnalysisInput(marketData);

  const analysis = await analyzeWithAI(aiInput, env);

  const m5Indicators = marketData.M5.indicators;

  let signal = calculateSignal(
    analysis,
    m5Indicators,
    "M5"
  );

  if (
    signal.decision !== "WAIT" &&
    !alignedWithHigherTimeframes(signal.decision, marketData)
  ) {
    signal = {
      decision: "WAIT",
      reason:
        "M15 and H1 trends do not both confirm the M5 direction."
    };
  }

  let telegramSent = false;
  let duplicate = false;

  if (sendAlert && signal.decision !== "WAIT") {
    const key = makeSignalKey(signal);

    duplicate = await alreadySent(env, key);

    if (!duplicate) {
      // Only mark the signal after Telegram confirms delivery.
      await sendTelegram(env, formatSignalMessage(signal));

      await markSent(env, key, signal);

      telegramSent = true;
    }
  }

  return {
    success: true,
    symbol: SYMBOL,
    analysis,
    signal,
    market: {
      M5: marketData.M5.indicators,
      M15: marketData.M15.indicators,
      H1: marketData.H1.indicators
    },
    telegramSent,
    duplicate,
    checkedAt: new Date().toISOString()
  };
}

// ------------------------------
// AUTOMATIC FIVE-MINUTE CRON
// ------------------------------

async function runScheduledAnalysis(env) {
  try {
    console.log("SIR BOT AI scheduled analysis started.");

    const result = await runAnalysis(env, true);

    console.log(
      "Scheduled analysis result:",
      JSON.stringify({
        decision: result.signal?.decision ?? result.decision,
        telegramSent: result.telegramSent ?? false,
        duplicate: result.duplicate ?? false,
        reason: result.reason ?? result.signal?.reason
      })
    );

    return result;
  } catch (error) {
    console.error(
      "SIR BOT AI scheduled analysis failed:",
      error.message
    );

    throw error;
  }
}

// ------------------------------
// WORKER ROUTES
// ------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return corsResponse();
    }

    try {
      if (path === "/health") {
        return response({
          success: true,
          service: "SIR BOT AI",
          status: "online",
          marketDataConfigured: Boolean(env.REALMARKETAPI_KEY),
          aiConfigured: Boolean(env.TCHAVI_API_KEY),
          telegramConfigured: Boolean(
            env.TELEGRAM_BOT_TOKEN &&
            env.TELEGRAM_CHAT_ID
          ),
          kvConfigured: Boolean(env.SIGNAL_DEDUPE),
          tradingExecution: "DISABLED",
          checkedAt: new Date().toISOString()
        });
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

      if (path === "/market-check") {
        const candles = await getCandles(env, "M5");

        return response({
          success: true,
          symbol: SYMBOL,
          price: candles.at(-1).close,
          candleTime: candles.at(-1).time,
          candlesReceived: candles.length
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
          indicators: calculateIndicators(candles)
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
        const result = await runAnalysis(env, false);

        return response(result);
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

        const result = await runAnalysis(env, true);

        return response(result);
      }

      return response(
        {
          error: "Route not found.",
          availableRoutes: [
            "/health",
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
      console.error("Request failed:", error);

      return response(
        {
          success: false,
          error: error.message
        },
        500
      );
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledAnalysis(env));
  }
};
