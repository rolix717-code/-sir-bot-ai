const ALLOWED_ORIGIN = "https://rolix717-code.github.io";

const TCHAVI_URL =
  "https://tchavi.com/api/v1/chat/completions";

const MARKET_PRICE_URL =
  "https://api.realmarketapi.com/api/v1/price";

const MARKET_CANDLE_URL =
  "https://api.realmarketapi.com/api/v1/candle";

// RESPONSE
function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Cache-Control": "no-store"
    }
  });
}

// AUTHENTICATION
function authorized(request, env) {
  return Boolean(
    env.TELEGRAM_TEST_SECRET &&
    request.headers.get("Authorization") ===
      `Bearer ${env.TELEGRAM_TEST_SECRET}`
  );
}

// TELEGRAM MESSAGE
async function sendTelegram(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error("Telegram credentials missing");
  }

  const result = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message
      })
    }
  );

  const data = await result.json();

  if (!result.ok || !data.ok) {
    throw new Error(
      data.description || "Telegram delivery failed"
    );
  }

  return data;
}

// NORMALIZE CANDLES
function normalizeCandle(c) {
  return {
    open: Number(c.OpenPrice ?? c.openPrice ?? c.open),
    high: Number(c.HighPrice ?? c.highPrice ?? c.high),
    low: Number(c.LowPrice ?? c.lowPrice ?? c.low),
    close: Number(c.ClosePrice ?? c.closePrice ?? c.close),
    volume: Number(c.Volume ?? c.volume ?? 0),
    time: c.OpenTime ?? c.openTime ?? c.time
  };
}

// VALIDATE CANDLES
function validCandle(c) {
  return (
    [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close) &&
    c.high >= c.low &&
    Number.isFinite(Date.parse(c.time))
  );
}

// EMA
function calculateEMA(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * multiplier + ema;
  }

  return ema;
}

// RSI
function calculateRSI(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    if (change < 0) losses -= change;
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    averageGain =
      (averageGain * (period - 1) + Math.max(change, 0)) /
      period;

    averageLoss =
      (averageLoss * (period - 1) + Math.max(-change, 0)) /
      period;
  }

  if (averageLoss === 0) {
    return averageGain === 0 ? 50 : 100;
  }

  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

// ATR
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

  let atr =
    ranges.slice(0, period).reduce((a, b) => a + b, 0) /
    period;

  for (let i = period; i < ranges.length; i++) {
    atr =
      (atr * (period - 1) + ranges[i]) / period;
  }

  return atr;
}

// MACD
function calculateMACD(values) {
  if (values.length < 35) return null;

  const fast = calculateEMA(values, 12);
  const slow = calculateEMA(values, 26);

  if (fast === null || slow === null) return null;

  const macdValues = [];

  for (let i = 0; i < values.length; i++) {
    const subset = values.slice(0, i + 1);

    const f = calculateEMA(subset, 12);
    const s = calculateEMA(subset, 26);

    if (f !== null && s !== null) {
      macdValues.push(f - s);
    }
  }

  const macd = macdValues[macdValues.length - 1];
  const signal = calculateEMA(macdValues, 9);

  return {
    macd,
    signal,
    histogram: macd - signal
  };
}

// MARKET STRUCTURE
function calculateStructure(candles) {
  const recent = candles.slice(-20);
  const previous = candles.slice(-40, -20);

  if (recent.length < 20 || previous.length < 20) {
    return "INSUFFICIENT_DATA";
  }

  const recentHigh = Math.max(...recent.map(c => c.high));
  const recentLow = Math.min(...recent.map(c => c.low));

  const previousHigh = Math.max(...previous.map(c => c.high));
  const previousLow = Math.min(...previous.map(c => c.low));

  if (
    recentHigh > previousHigh &&
    recentLow > previousLow
  ) {
    return "HIGHER_HIGHS_HIGHER_LOWS";
  }

  if (
    recentHigh < previousHigh &&
    recentLow < previousLow
  ) {
    return "LOWER_HIGHS_LOWER_LOWS";
  }

  return "SIDEWAYS_OR_MIXED";
}

// INDICATORS
function calculateIndicators(candles) {
  const closes = candles.map(c => c.close);

  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const rsi14 = calculateRSI(closes);
  const atr14 = calculateATR(candles);
  const macd = calculateMACD(closes);

  let trend = "SIDEWAYS";

  if (ema20 !== null && ema50 !== null) {
    if (ema20 > ema50) trend = "BULLISH";
    if (ema20 < ema50) trend = "BEARISH";
  }

  let rsiCondition = "NEUTRAL";

  if (rsi14 !== null) {
    if (rsi14 >= 70) rsiCondition = "OVERBOUGHT";
    else if (rsi14 <= 30) rsiCondition = "OVERSOLD";
  }

  let macdCondition = "NEUTRAL";

  if (macd) {
    if (macd.histogram > 0) macdCondition = "BULLISH";
    if (macd.histogram < 0) macdCondition = "BEARISH";
  }

  return {
    ema: { ema20, ema50 },

    rsi: {
      value: rsi14,
      condition: rsiCondition
    },

    macd: macd ? {
      value: macd.macd,
      signal: macd.signal,
      histogram: macd.histogram,
      condition: macdCondition
    } : null,

    atr14,
    trend,
    market_structure: calculateStructure(candles),
    latest_price: closes[closes.length - 1]
  };
}

// GET CANDLES
async function getCandles(env, timeframe) {
  const params = new URLSearchParams({
    apiKey: env.REALMARKETAPI_KEY,
    symbolCode: "XAUUSD",
    timeFrame: timeframe
  });

  const result = await fetch(
    `${MARKET_CANDLE_URL}?${params}`
  );

  if (!result.ok) {
    throw new Error(`Market provider returned ${result.status}`);
  }

  const raw = await result.json();

  const rows = Array.isArray(raw)
    ? raw
    : raw.Data ?? raw.data ?? [];

  const candles = rows
    .map(normalizeCandle)
    .filter(validCandle)
    .sort((a, b) =>
      Date.parse(a.time) - Date.parse(b.time)
    );

  if (candles.length < 50) {
    throw new Error(
      `Insufficient candles: ${candles.length}`
    );
  }

  return candles.slice(-300);
}

// AI ANALYSIS
async function analyzeCandles(env, candles, timeframe, indicators) {
  const aiResponse = await fetch(TCHAVI_URL, {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.TCHAVI_API_KEY}`
    },

    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,

      messages: [
        {
          role: "system",

          content: `
You are SIR BOT AI, an XAUUSD market analysis system.

Analyze genuine OHLCV candles and calculated indicators.

Use:
- EMA20 and EMA50
- RSI14
- MACD
- ATR14
- Market structure
- Price action
- Liquidity concepts
- Support and resistance
- Fair Value Gaps where identifiable

Consider the M1, M5, M15 and H1 context when available.
Only the supplied timeframe is directly available in this request.
Do not pretend to have inspected unavailable timeframes.

Choose WAIT when evidence is insufficient.

Return ONLY valid JSON:

{
  "decision": "WAIT",
  "confidence": 0,
  "trend": "SIDEWAYS",
  "reasoning": "Explanation",
  "risk_warning": "Trading involves risk"
}

Allowed decisions: BUY, SELL, WAIT.
Allowed trends: BULLISH, BEARISH, SIDEWAYS.

Never invent prices.
Never promise profits.
Never claim to execute trades.
`
        },

        {
          role: "user",
          content: JSON.stringify({
            market: "XAUUSD",
            timeframe,
            indicators,
            candles: candles.slice(-100)
          })
        }
      ]
    })
  });

  if (!aiResponse.ok) {
    throw new Error(`Tchavi returned ${aiResponse.status}`);
  }

  const result = await aiResponse.json();

  const content = result.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("Empty AI response");
  }

  const analysis = JSON.parse(
    content.replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim()
  );

  if (
    !["BUY", "SELL", "WAIT"].includes(analysis.decision) ||
    !Number.isFinite(analysis.confidence) ||
    analysis.confidence < 0 ||
    analysis.confidence > 100 ||
    !["BULLISH", "BEARISH", "SIDEWAYS"].includes(analysis.trend)
  ) {
    throw new Error("Invalid AI analysis");
  }

  return analysis;
}

// CALCULATE SIGNAL LEVELS
function calculateSignal(analysis, indicators, timeframe) {
  const entry = indicators.latest_price;
  const atr = indicators.atr14;

  if (
    analysis.decision === "WAIT" ||
    analysis.confidence < 70 ||
    !Number.isFinite(entry) ||
    !Number.isFinite(atr) ||
    atr <= 0
  ) {
    return {
      decision: "WAIT",
      reason: "Signal did not meet validation requirements."
    };
  }

  if (
    analysis.decision === "BUY" &&
    analysis.trend !== "BULLISH"
  ) {
    return {
      decision: "WAIT",
      reason: "Trend confirmation missing."
    };
  }

  if (
    analysis.decision === "SELL" &&
    analysis.trend !== "BEARISH"
  ) {
    return {
      decision: "WAIT",
      reason: "Trend confirmation missing."
    };
  }

  const riskDistance = atr * 1.5;

  let sl;
  let tp1;
  let tp2;
  let tp3;

  if (analysis.decision === "BUY") {
    sl = entry - riskDistance;
    tp1 = entry + riskDistance;
    tp2 = entry + riskDistance * 2;
    tp3 = entry + riskDistance * 3;
  } else {
    sl = entry + riskDistance;
    tp1 = entry - riskDistance;
    tp2 = entry - riskDistance * 2;
    tp3 = entry - riskDistance * 3;
  }

  return {
    decision: analysis.decision,
    confidence: analysis.confidence,
    timeframe,

    entry: Number(entry.toFixed(3)),
    stop_loss: Number(sl.toFixed(3)),
    take_profit_1: Number(tp1.toFixed(3)),
    take_profit_2: Number(tp2.toFixed(3)),
    take_profit_3: Number(tp3.toFixed(3)),

    risk_reward: ["1:1", "1:2", "1:3"],

    calculation: "ATR-based illustrative levels",
    status: "UNEXECUTED"
  };
}

// TELEGRAM SIGNAL MESSAGE
function formatSignalMessage(signal, analysis) {
  return `
🚀 SIR BOT AI — XAUUSD

${signal.decision === "BUY" ? "🟢 BUY" : "🔴 SELL"}

Entry: ${signal.entry}
Stop Loss: ${signal.stop_loss}

TP1: ${signal.take_profit_1}
TP2: ${signal.take_profit_2}
TP3: ${signal.take_profit_3}

Risk/Reward: 1:1 / 1:2 / 1:3
Confidence: ${signal.confidence}%
Timeframe: ${signal.timeframe}

Trend: ${analysis.trend}

Analysis:
${analysis.reasoning}

⚠️ These are AI-generated analysis levels, not guaranteed outcomes.

Trading execution: DISABLED.
`.trim();
}

// MAIN WORKER
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (origin && origin !== ALLOWED_ORIGIN) {
      return response({ error: "Origin not allowed" }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization"
        }
      });
    }

    const url = new URL(request.url);

    // HEALTH
    if (url.pathname === "/health" && request.method === "GET") {
      return response({
        project: "SIR BOT AI",
        status: "online",
        market: "XAUUSD",
        ai: env.TCHAVI_API_KEY ? "configured" : "missing",
        market_data: env.REALMARKETAPI_KEY ? "configured" : "missing",
        telegram: env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
          ? "configured"
          : "missing",
        trading: "disabled"
      });
    }

    // TELEGRAM CONNECTION TEST
    if (
      url.pathname === "/telegram-test" &&
      request.method === "POST"
    ) {
      if (!authorized(request, env)) {
        return response({ error: "Unauthorized" }, 401);
      }

      try {
        await sendTelegram(
          env,
          "🚀 SIR BOT AI\n\nTelegram connection successful!\n\nXAUUSD signal system is being configured.\n\nTrading execution: DISABLED."
        );

        return response({
          success: true,
          message: "Telegram connected successfully"
        });
      } catch (error) {
        return response({
          success: false,
          error: error.message
        }, 502);
      }
    }

    // TIMEFRAME VALIDATION
    const timeframe =
      url.searchParams.get("timeframe") || "M1";

    if (!["M1", "M5", "M15", "H1"].includes(timeframe)) {
      return response({ error: "Unsupported timeframe" }, 400);
    }

    // MARKET PRICE
    if (
      url.pathname === "/market-check" &&
      request.method === "GET"
    ) {
      if (!env.REALMARKETAPI_KEY) {
        return response({ error: "Market API key missing" }, 500);
      }

      try {
        const params = new URLSearchParams({
          apiKey: env.REALMARKETAPI_KEY,
          symbolCode: "XAUUSD",
          timeFrame: timeframe
        });

        const result = await fetch(
          `${MARKET_PRICE_URL}?${params}`
        );

        if (!result.ok) {
          throw new Error(`Provider returned ${result.status}`);
        }

        const market = await result.json();

        const bid = Number(market.bid ?? market.Bid);
        const ask = Number(market.ask ?? market.Ask);
        const close = Number(
          market.closePrice ?? market.ClosePrice
        );

        if (
          ![bid, ask, close].every(Number.isFinite) ||
          ask < bid
        ) {
          throw new Error("Invalid market prices");
        }

        return response({
          project: "SIR BOT AI",
          market: "XAUUSD",
          timeframe,
          data_status: "connected",

          prices: {
            open: Number(market.openPrice ?? market.OpenPrice),
            close,
            high: Number(market.highPrice ?? market.HighPrice),
            low: Number(market.lowPrice ?? market.LowPrice),
            bid,
            ask,
            spread: Number((ask - bid).toFixed(3))
          },

          received_at: new Date().toISOString(),
          trading: "disabled"
        });
      } catch (error) {
        return response({
          error: "Market price request failed",
          details: error.message
        }, 502);
      }
    }

    // INDICATORS
    if (
      url.pathname === "/indicators" &&
      request.method === "GET"
    ) {
      try {
        const candles = await getCandles(env, timeframe);
        const indicators = calculateIndicators(candles);

        return response({
          project: "SIR BOT AI",
          market: "XAUUSD",
          timeframe,
          candle_count: candles.length,
          latest_candle: candles[candles.length - 1].time,
          indicators,
          trading: "disabled"
        });
      } catch (error) {
        return response({
          error: "Indicator calculation failed",
          details: error.message
        }, 502);
      }
    }

    // MARKET CANDLES
    if (
      url.pathname === "/market-candles" &&
      request.method === "GET"
    ) {
      try {
        const candles = await getCandles(env, timeframe);

        return response({
          project: "SIR BOT AI",
          market: "XAUUSD",
          timeframe,
          candle_count: candles.length,
          candles,
          trading: "disabled"
        });
      } catch (error) {
        return response({
          error: "Candle retrieval failed",
          details: error.message
        }, 502);
      }
    }

    // LIVE AI ANALYSIS
    if (
      url.pathname === "/analyze-live" &&
      request.method === "GET"
    ) {
      if (!env.REALMARKETAPI_KEY || !env.TCHAVI_API_KEY) {
        return response({
          error: "Required API key missing"
        }, 500);
      }

      try {
        const candles = await getCandles(env, timeframe);
        const indicators = calculateIndicators(candles);

        const analysis = await analyzeCandles(
          env,
          candles,
          timeframe,
          indicators
        );

        const signal = calculateSignal(
          analysis,
          indicators,
          timeframe
        );

        return response({
          project: "SIR BOT AI",
          market: "XAUUSD",
          timeframe,
          candle_count: candles.length,
          latest_candle: candles[candles.length - 1].time,
          indicators,
          analysis,
          signal,
          execution: "disabled",
          warning: "AI analysis is not a guaranteed trading signal."
        });
      } catch (error) {
        return response({
          error: "Live analysis failed",
          details: error.message
        }, 502);
      }
    }

    // ANALYZE AND SEND TELEGRAM SIGNAL
    if (
      url.pathname === "/analyze-and-notify" &&
      request.method === "POST"
    ) {
      if (!authorized(request, env)) {
        return response({ error: "Unauthorized" }, 401);
      }

      try {
        const candles = await getCandles(env, timeframe);
        const indicators = calculateIndicators(candles);

        const analysis = await analyzeCandles(
          env,
          candles,
          timeframe,
          indicators
        );

        const signal = calculateSignal(
          analysis,
          indicators,
          timeframe
        );

        if (signal.decision === "WAIT") {
          return response({
            success: true,
            notification_sent: false,
            message: "No qualifying signal. WAIT.",
            analysis,
            signal
          });
        }

        await sendTelegram(
          env,
          formatSignalMessage(signal, analysis)
        );

        return response({
          success: true,
          notification_sent: true,
          analysis,
          signal,
          execution: "disabled"
        });
      } catch (error) {
        return response({
          success: false,
          error: error.message
        }, 502);
      }
    }

    return response({
      project: "SIR BOT AI",
      status: "online",
      trading: "disabled"
    });
  }
};
