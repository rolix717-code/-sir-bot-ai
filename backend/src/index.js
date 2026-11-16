const ALLOWED_ORIGIN = "https://rolix717-code.github.io";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");

    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Vary": "Origin"
    };

    if (origin && origin !== ALLOWED_ORIGIN) {
      return json({ error: "Origin not allowed" }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    const url = new URL(request.url);

    // Check backend status
    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        project: "SIR BOT AI",
        status: "online",
        market: "XAUUSD",
        ai: "not connected",
        mt5: "not connected",
        trading: "disabled",
        message: "Backend foundation is running."
      }, 200, corsHeaders);
    }

    // AI analysis endpoint
    if (url.pathname === "/analyze" && request.method === "POST") {
      let body;

      try {
        body = await request.json();
      } catch {
        return json({
          error: "Send valid JSON."
        }, 400, corsHeaders);
      }

      if (body.market && body.market !== "XAUUSD") {
        return json({
          error: "SIR BOT AI supports XAUUSD only."
        }, 400, corsHeaders);
      }

      return json({
        project: "SIR BOT AI",
        market: "XAUUSD",
        decision: "WAIT",
        confidence: null,
        reason: "AI and verified live gold market data are not connected yet.",
        execution: "disabled"
      }, 503, corsHeaders);
    }

    return json({
      project: "SIR BOT AI",
      message: "Backend is running. Visit /health to check its status."
    }, 200, corsHeaders);
  }
};
