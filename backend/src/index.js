const ALLOWED_ORIGIN = "https://rolix717-code.github.io";

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
        ai: "Tchavi configured",
        trading: "disabled"
      });
    }

    // AI GOLD ANALYSIS
    if (url.pathname === "/analyze" && request.method === "POST") {

      if (!env.TCHAVI_API_KEY) {
        return response({
          error: "Tchavi API key is missing"
        }, 500);
      }

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
          error: "SIR BOT AI only analyzes XAUUSD"
        }, 400);
      }

      if (
        !Array.isArray(data.candles) ||
        data.candles.length < 20 ||
        data.candles.length > 200
      ) {
        return response({
          error: "Provide between 20 and 200 market candles"
        }, 400);
      }

      const systemPrompt = `
You are the market analysis intelligence of SIR BOT AI.

Your only market is XAUUSD (Gold).

Analyze supplied OHLCV candle data.
Evaluate:
- Market structure
- Trend direction
- Support and resistance
- Momentum
- Candlestick patterns
- Possible liquidity areas
- Risk and reward

Never invent market prices or missing data.

Return ONLY valid JSON using this structure:

{
  "decision": "BUY, SELL, or WAIT",
  "confidence": 0,
  "trend": "BULLISH, BEARISH, or SIDEWAYS",
  "reasoning": "Explanation of analysis",
  "entry": null,
  "stop_loss": null,
  "take_profit": null,
  "risk_warning": "Trading involves risk"
}

If the evidence is insufficient, choose WAIT.

This is analysis only. Do not claim to have executed trades.
`;

      try {

        const aiResponse = await fetch(
          "https://tchavi.com/api/v1/chat/completions",
          {
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
                    timeframe: data.timeframe || "M5",
                    candles: data.candles
                  })
                }
              ]
            })
          }
        );

        if (!aiResponse.ok) {
          return response({
            error: "AI provider request failed",
            provider_status: aiResponse.status
          }, 502);
        }

        const result = await aiResponse.json();

        const content =
          result.choices?.[0]?.message?.content;

        if (!content) {
          return response({
            error: "AI returned an empty response"
          }, 502);
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
          return response({
            error: "AI returned an invalid analysis"
          }, 502);
        }

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
      message: "Welcome to SIR BOT AI"
    });
  }
};
