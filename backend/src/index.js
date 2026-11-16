const ALLOWED_ORIGIN = "https://rolix717-code.github.io";

const TCHAVI_URL =
  "https://tchavi.com/api/v1/chat/completions";

const MARKET_URL =
  "https://api.realmarketapi.com/api/v1/price";

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

    // HEALTH CHECK
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

    // LIVE XAUUSD PRICE
    if (url.pathname === "/market-check" && request.method === "GET") {

      if (!env.REALMARKETAPI_KEY) {
        return response({
          error: "Market API key missing"
        }, 500);
      }

      const timeframe = url.searchParams.get("timeframe") || "M1";

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
            error: "Market provider request failed",
            provider_status: marketResponse.status
          }, 502);
        }

        const market = await marketResponse.json();

        const open = Number(market.openPrice);
        const close = Number(market.closePrice);
        const high = Number(market.highPrice);
        const low = Number(market.lowPrice);
        const bid = Number(market.bid);
        const ask = Number(market.ask);

        if (
          !Number.isFinite(close) ||
          !Number.isFinite(bid) ||
          !Number.isFinite(ask) ||
          ask < bid
        ) {
          return response({
            error: "Invalid market price response"
          }, 502);
        }

        return response({
          project: "SIR BOT AI",
          market: "XAUUSD",
          timeframe,
          data_status: "connected",
          prices: {
            open,
            close,
            high,
            low,
            bid,
            ask,
            spread: Number((ask - bid).toFixed(3))
          },
          volume: market.volume,
          market_time: market.openTime || null,
          received_at: new Date().toISOString(),
          trading: "disabled",
          warning: "Latest price data only. Not a trading signal."
        });

      } catch (error) {
        return response({
          error: "Market data connection failed",
          details: error.message
        }, 500);
      }
    }

    // MANUAL AI ANALYSIS
    if (url.pathname === "/analyze" && request.method === "POST") {

      if (!env.TCHAVI_API_KEY) {
        return response({
          error: "Tchavi API key missing"
        }, 500);
      }

      let data;

      try {
        data = await request.json();
      } catch {
        return response({
          error: "Invalid JSON"
        }, 400);
      }

      if (
        data.market !== "XAUUSD" ||
        !Array.isArray(data.candles) ||
        data.candles.length < 20 ||
        data.candles.length > 200
      ) {
        return response({
          error: "XAUUSD analysis requires 20 to 200 candles"
        }, 400);
      }

      for (const candle of data.candles) {
        const values = [
          candle.open,
          candle.high,
          candle.low,
          candle.close
        ].map(Number);

        if (
          values.some(v => !Number.isFinite(v)) ||
          values[1] < values[2] ||
          values[1] < Math.max(values[0], values[3]) ||
          values[2] > Math.min(values[0], values[3])
        ) {
          return response({
            error: "Invalid candle data"
          }, 400);
        }
      }

      try {
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

Analyze the supplied OHLCV candles.

Return ONLY JSON:

{
  "decision": "BUY, SELL, or WAIT",
  "confidence": 0,
  "trend": "BULLISH, BEARISH, or SIDEWAYS",
  "reasoning": "Explanation",
  "risk_warning": "Trading involves risk"
}

Choose WAIT when evidence is insufficient.
Never claim to execute trades.
`
              },
              {
                role: "user",
                content: JSON.stringify({
                  market: "XAUUSD",
                  timeframe: data.timeframe || "M5",
                  candles: data.candles
                })
              }
            ]
          })
        });

        if (!aiResponse.ok) {
          return response({
            error: "Tchavi request failed",
            provider_status: aiResponse.status
          }, 502);
        }

        const result = await aiResponse.json();
        const content = result.choices?.[0]?.message?.content;

        if (!content) {
          return response({
            error: "Empty AI response"
          }, 502);
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
          analysis.confidence > 100
        ) {
          return response({
            error: "Invalid AI analysis"
          }, 502);
        }

        return response({
          project: "SIR BOT AI",
          market: "XAUUSD",
          ai: "connected",
          analysis,
          execution: "disabled"
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
      trading: "disabled"
    });
  }
};
