const ALLOWED_ORIGIN = "https://rolix717-code.github.io";

const TCHAVI_URL =
  "https://tchavi.com/api/v1/chat/completions";

const MARKET_PRICE_URL =
  "https://api.realmarketapi.com/api/v1/price";

const MARKET_CANDLE_URL =
  "https://api.realmarketapi.com/api/v1/candle";

function response(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store"
    }
  });
}

function normalizeCandle(c) {
  return {
    open: Number(c.OpenPrice ?? c.openPrice),
    high: Number(c.HighPrice ?? c.highPrice),
    low: Number(c.LowPrice ?? c.lowPrice),
    close: Number(c.ClosePrice ?? c.closePrice),
    volume: Number(c.Volume ?? c.volume ?? 0),
    time: c.OpenTime ?? c.openTime
  };
}

function validCandle(c) {
  const values = [c.open, c.high, c.low, c.close];

  return (
    values.every(Number.isFinite) &&
    c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close) &&
    c.high >= c.low &&
    Number.isFinite(Date.parse(c.time))
  );
}

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
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  if (candles.length < 20) {
    throw new Error(
      `Insufficient valid candles: ${candles.length}`
    );
  }

  return candles.slice(-300);
}

async function analyzeCandles(env, candles, timeframe) {
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
You are SIR BOT AI, an XAUUSD market analysis assistant.

Analyze the genuine supplied OHLCV candles.

Consider:
- Market structure
- Trend
- Momentum
- Recent price action
- Volatility

Return ONLY JSON:

{
  "decision": "BUY, SELL, or WAIT",
  "confidence": 0,
  "trend": "BULLISH, BEARISH, or SIDEWAYS",
  "reasoning": "Explanation",
  "risk_warning": "Trading involves risk"
}

Choose WAIT when evidence is insufficient.
Never invent prices.
Never claim to execute trades.
`
        },
        {
          role: "user",
          content: JSON.stringify({
            market: "XAUUSD",
            timeframe,
            candles
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
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return response({
        project: "SIR BOT AI",
        status: "online",
        market: "XAUUSD",
        ai: env.TCHAVI_API_KEY ? "configured" : "missing",
        market_data: env.REALMARKETAPI_KEY ? "configured" : "missing",
        trading: "disabled"
      });
    }

    if (!env.REALMARKETAPI_KEY) {
      return response({ error: "Market API key missing" }, 500);
    }

    const timeframe = url.searchParams.get("timeframe") || "M1";

    if (!["M1", "M5", "H1"].includes(timeframe)) {
      return response({ error: "Unsupported timeframe" }, 400);
    }

    // LATEST PRICE
    if (url.pathname === "/market-check" && request.method === "GET") {
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
          return response({
            error: "Market provider failed",
            provider_status: result.status
          }, 502);
        }

        const market = await result.json();

        return response({
          project: "SIR BOT AI",
          market: "XAUUSD",
          timeframe,
          data_status: "connected",
          prices: {
            open: Number(market.openPrice ?? market.OpenPrice),
            close: Number(market.closePrice ?? market.ClosePrice),
            high: Number(market.highPrice ?? market.HighPrice),
            low: Number(market.lowPrice ?? market.LowPrice),
            bid: Number(market.bid ?? market.Bid),
            ask: Number(market.ask ?? market.Ask)
          },
          received_at: new Date().toISOString(),
          trading: "disabled"
        });

      } catch (error) {
        return response({ error: error.message }, 502);
      }
    }

    // MULTIPLE MARKET CANDLES
    if (url.pathname === "/market-candles" && request.method === "GET") {
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

    // AUTOMATIC LIVE MARKET ANALYSIS
    if (url.pathname === "/analyze-live" && request.method === "GET") {
      if (!env.TCHAVI_API_KEY) {
        return response({ error: "Tchavi key missing" }, 500);
      }

      try {
        const candles = await getCandles(env, timeframe);

        const analysis = await analyzeCandles(
          env,
          candles,
          timeframe
        );

        return response({
          project: "SIR BOT AI",
          market: "XAUUSD",
          timeframe,
          candle_count: candles.length,
          latest_candle: candles[candles.length - 1].time,
          ai: "connected",
          analysis,
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

    // MANUAL AI ANALYSIS
    if (url.pathname === "/analyze" && request.method === "POST") {
      if (!env.TCHAVI_API_KEY) {
        return response({ error: "Tchavi key missing" }, 500);
      }

      try {
        const data = await request.json();

        if (
          data.market !== "XAUUSD" ||
          !Array.isArray(data.candles) ||
          data.candles.length < 20 ||
          data.candles.length > 300
        ) {
          return response({
            error: "Provide 20 to 300 XAUUSD candles"
          }, 400);
        }

        const candles = data.candles.map(c => ({
          ...c,
          open: Number(c.open),
          high: Number(c.high),
          low: Number(c.low),
          close: Number(c.close),
          time: c.time || c.openTime
        }));

        if (!candles.every(validCandle)) {
          return response({ error: "Invalid candle data" }, 400);
        }

        const analysis = await analyzeCandles(
          env,
          candles,
          data.timeframe || "M1"
        );

        return response({
          project: "SIR BOT AI",
          market: "XAUUSD",
          analysis,
          execution: "disabled"
        });

      } catch (error) {
        return response({
          error: "AI analysis failed",
          details: error.message
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
