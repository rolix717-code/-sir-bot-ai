const ALLOWED_ORIGIN = "https://rolix717-code.github.io";

const TCHAVI_URL =
  "https://tchavi.com/api/v1/chat/completions";

const MARKET_URL =
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

// NORMALIZE MARKET CANDLES
function normalizeCandles(data) {
  let candles = Array.isArray(data)
    ? data
    : data.Data || data.data || data.candles || [];

  if (!Array.isArray(candles)) {
    throw new Error("Invalid candle response");
  }

  candles = candles.map(c => ({
    open: Number(c.OpenPrice ?? c.open),
    high: Number(c.HighPrice ?? c.high),
    low: Number(c.LowPrice ?? c.low),
    close: Number(c.ClosePrice ?? c.close),
    volume: Number(c.Volume ?? c.volume ?? 0)
  }));

  candles = candles.filter(c =>
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    c.high >= c.low &&
    c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close)
  );

  // Provider returns recent candles first.
  // Reverse them into oldest-to-newest order.
  return candles.slice(0, 200).reverse();
}

// TCHAVI AI ANALYSIS
async function analyzeWithAI(env, candles, timeframe) {

  if (!env.TCHAVI_API_KEY) {
    throw new Error("Tchavi API key is missing");
  }

  const systemPrompt = `
You are SIR BOT AI, an XAUUSD market analysis intelligence.

Analyze the supplied REAL market OHLCV candles.

Evaluate:
- Market structure
- Trend direction
- Support and resistance
- Momentum
- Candlestick patterns
- Liquidity areas
- Risk and reward

Never invent market prices.

Return ONLY valid JSON:

{
  "decision": "BUY, SELL, or WAIT",
  "confidence": 0,
  "trend": "BULLISH, BEARISH, or SIDEWAYS",
  "reasoning": "Explanation",
  "entry": null,
  "stop_loss": null,
  "take_profit": null,
  "risk_warning": "Trading involves risk"
}

If evidence is insufficient, choose WAIT.

This is analysis only.
Never claim to execute a trade.
`;

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
          content: systemPrompt
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
    throw new Error(
      `Tchavi provider returned HTTP ${aiResponse.status}`
    );
  }

  const result = await aiResponse.json();

  const content = result.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error("AI returned an empty response");
  }

  const cleanContent = content
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const analysis = JSON.parse(cleanContent);

  const validDecisions = ["BUY", "SELL", "WAIT"];

  if (
    !validDecisions.includes(analysis.decision) ||
    !Number.isFinite(analysis.confidence) ||
    analysis.confidence < 0 ||
    analysis.confidence > 100
  ) {
    throw new Error("AI returned invalid analysis");
  }

  return analysis;
}

export default {

  async fetch(request, env) {

    const origin = request.headers.get("Origin");

    if (origin && origin !== ALLOWED_ORIGIN) {
      return response({
        error: "Origin not allowed"
      }, 403);
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

    // HEALTH CHECK
    if (
      url.pathname === "/health" &&
      request.method === "GET"
    ) {
      return response({
        project: "SIR BOT AI",
        status: "online",
        market: "XAUUSD",
        ai: env.TCHAVI_API_KEY
          ? "configured"
          : "missing",
        market_data: env.REALMARKETAPI_KEY
          ? "configured"
          : "missing",
        trading: "disabled"
      });
    }

    // LIVE XAUUSD MARKET DATA
    if (
      url.pathname === "/market-check" &&
      request.method === "GET"
    ) {

      if (!env.REALMARKETAPI_KEY) {
        return response({
          error: "Market API key is missing"
        }, 500);
      }

      const timeframe =
        url.searchParams.get("timeframe") || "M5";

      const allowedTimeframes = ["M1", "M5", "H1"];

      if (!allowedTimeframes.includes(timeframe)) {
        return response({
          error: "Unsupported timeframe"
        }, 400);
      }

      try {

        const params = new URLSearchParams({
          apiKey: env.REALMARKETAPI_KEY,
          symbolCode: "XAUUSD",
          timeFrame: timeframe
        });

        const marketResponse = await fetch(
          `${MARKET_URL}?${params}`
        );

        if (!marketResponse.ok) {
          return response({
            error: "Market provider request failed",
            provider_status: marketResponse.status
          }, 502);
        }

        const marketData = await marketResponse.json();

        const candles = normalizeCandles(marketData);

        if (candles.length < 20) {
          return response({
            error: "Insufficient market candles",
            received: candles.length
          }, 502);
        }

        return response({
          project: "SIR BOT AI",
          market: "XAUUSD",
          timeframe,
          data_status: "connected",
          candle_count: candles.length,
          candles,
          trading: "disabled"
        });

      } catch (error) {

        return response({
          error: "Market data request failed",
          details: error.message
        }, 500);

      }
    }

    // LIVE AI ANALYSIS
    if (
      url.pathname === "/live-analysis" &&
      request.method === "GET"
    ) {

      if (!env.REALMARKETAPI_KEY ||
          !env.TCHAVI_API_KEY) {
        return response({
          error: "Required API keys are missing"
        }, 500);
      }

      const timeframe =
        url.searchParams.get("timeframe") || "M5";

      if (!["M1", "M5", "H1"].includes(timeframe)) {
        return response({
          error: "Unsupported timeframe"
        }, 400);
      }

      try {

        const params = new URLSearchParams({
          apiKey: env.REALMARKETAPI_KEY,
          symbolCode: "XAUUSD",
          timeFrame: timeframe
        });

        const marketResponse = await fetch(
          `${MARKET_URL}?${params}`
        );

        if (!marketResponse.ok) {
          return response({
            error: "Market data provider failed",
            provider_status: marketResponse.status
          }, 502);
        }

        const marketData = await marketResponse.json();

        const candles = normalizeCandles(marketData);

        if (candles.length < 20) {
          return response({
            error: "Not enough candles for analysis",
            received: candles.length
          }, 502);
        }

        const analysis = await analyzeWithAI(
          env,
          candles,
          timeframe
        );

        return response({
          project: "SIR BOT AI",
          market: "XAUUSD",
          timeframe,
          data_status: "connected",
          ai_status: "connected",
          analysis,
          execution: "disabled",
          warning: "Analysis only. No trades are executed."
        });

      } catch (error) {

        return response({
          error: "Live analysis failed",
          details: error.message
        }, 500);

      }
    }

    // MANUAL CANDLE ANALYSIS
    if (
      url.pathname === "/analyze" &&
      request.method === "POST"
    ) {

      let data;

      try {
        data = await request.json();
      } catch {
        return response({
          error: "Invalid JSON request"
        }, 400);
      }

      if (data.market !== "XAUUSD") {
        return response({
          error: "Only XAUUSD is supported"
        }, 400);
      }

      if (
        !Array.isArray(data.candles) ||
        data.candles.length < 20 ||
        data.candles.length > 200
      ) {
        return response({
          error: "Provide 20 to 200 candles"
        }, 400);
      }

      try {

        const analysis = await analyzeWithAI(
          env,
          data.candles,
          data.timeframe || "M5"
        );

        return response({
          project: "SIR BOT AI",
          market: "XAUUSD",
          ai: "connected",
          execution: "disabled",
          analysis
        });

      } catch (error) {

        return response({
          error: "AI analysis failed",
          details: error.message
        }, 500);

      }
    }

    return response({
      project: "SIR BOT AI",
      status: "running",
      trading: "disabled",
      message: "SIR BOT AI backend"
    });

  }
};
