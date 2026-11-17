const API_BASE = "https://sir-bot-ai-backend.rolix717.workers.dev";

document.addEventListener("DOMContentLoaded", () => {
    const $ = id => document.getElementById(id);

    // NAVIGATION
    const pages = document.querySelectorAll(".page");
    const navItems = document.querySelectorAll(".nav-item");
    const sidebar = $("sidebar");

    const titles = {
        overview: "Overview",
        market: "Live Market",
        intelligence: "AI Intelligence",
        indicators: "Technical Indicators",
        risk: "Risk Center",
        account: "Trading Account"
    };

    function openPage(name) {
        pages.forEach(page =>
            page.classList.toggle("active", page.id === `page-${name}`)
        );

        navItems.forEach(item =>
            item.classList.toggle("active", item.dataset.page === name)
        );

        $("pageTitle").textContent = titles[name] || "Overview";

        sidebar.classList.remove("open");
        history.replaceState(null, "", `#${name}`);
    }

    navItems.forEach(item =>
        item.addEventListener("click", () => openPage(item.dataset.page))
    );

    document.querySelectorAll("[data-open]").forEach(button =>
        button.addEventListener("click", () => openPage(button.dataset.open))
    );

    $("menuBtn").addEventListener("click", () =>
        sidebar.classList.toggle("open")
    );

    const initialPage = location.hash.replace("#", "");
    openPage(titles[initialPage] ? initialPage : "overview");


    // API
    async function api(endpoint, timeoutMs = 30000) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(API_BASE + endpoint, {
                method: "GET",
                cache: "no-store",
                signal: controller.signal
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(
                    data.details || data.error || `HTTP ${response.status}`
                );
            }

            return data;
        } finally {
            clearTimeout(timeout);
        }
    }


    // BACKEND STATUS
    async function checkBackend() {
        try {
            const data = await api("/health");

            $("backendStatus").textContent = "ONLINE";
            $("sidebarStatus").textContent = "Backend online";
            $("marketConnection").textContent = data.marketData || data.market_data;
            $("aiConnection").textContent = data.ai;

        } catch (error) {
            $("backendStatus").textContent = "OFFLINE";
            $("sidebarStatus").textContent = "Connection failed";
            $("marketConnection").textContent = "Unavailable";
            $("aiConnection").textContent = "Unavailable";

            console.error("Backend:", error);
        }
    }


    // LIVE GOLD PRICE
    async function loadMarket() {
        try {
            const data = await api("/market-price?timeframe=M5");

            if (!data.success || !Number.isFinite(Number(data.price))) {
                throw new Error("Invalid market price response");
            }

            const price = Number(data.price);
            const formattedPrice = price.toFixed(3);

            $("overviewPrice").textContent = formattedPrice;
            $("mainPrice").textContent = formattedPrice;
            $("marketPrice").textContent = formattedPrice;

            $("mainBid").textContent = "—";
            $("mainAsk").textContent = "—";
            $("mainSpread").textContent = "—";

            $("marketBid").textContent = "—";
            $("marketAsk").textContent = "—";
            $("marketSpread").textContent = "—";

            const fresh = data.fresh === true;

            $("marketStatus").textContent =
                fresh ? "CONNECTED" : "STALE DATA";

            $("marketStatus2").textContent =
                fresh ? "CONNECTED" : "STALE DATA";

            $("marketUpdated").textContent =
                new Date().toLocaleTimeString();

            $("marketMessage").textContent = fresh
                ? `XAUUSD price updated. Candle age: ${data.ageMinutes} minutes.`
                : "Warning: market data is not fresh.";

        } catch (error) {
            $("marketStatus").textContent = "OFFLINE";
            $("marketStatus2").textContent = "OFFLINE";

            $("marketMessage").textContent =
                "Market connection error: " + error.message;

            console.error("Market:", error);
        }
    }


    // TECHNICAL INDICATORS
    async function loadIndicators() {
        $("indicatorMessage").textContent =
            "Calculating technical indicators...";

        try {
            const data = await api("/indicators?timeframe=M5");
            const i = data.indicators;

            if (!i) {
                throw new Error("Indicator data unavailable");
            }

            updateIndicators(i);

            $("indicatorMessage").textContent =
                `${data.candle_count} candles analyzed successfully.`;

        } catch (error) {
            $("indicatorMessage").textContent =
                "Indicator error: " + error.message;

            console.error("Indicators:", error);
        }
    }


    // UPDATE INDICATORS
    function updateIndicators(i) {
        $("ema20").textContent = Number(i.ema20).toFixed(3);
        $("ema50").textContent = Number(i.ema50).toFixed(3);

        $("rsi14").textContent = Number(i.rsi14).toFixed(2);
        $("rsiCondition").textContent = i.rsi_condition || "Calculated";

        if (i.macd) {
            $("macd").textContent = Number(i.macd.macd).toFixed(3);

            $("macdCondition").textContent =
                Number(i.macd.histogram) >= 0
                    ? "Positive momentum"
                    : "Negative momentum";
        }

        $("atr14").textContent = Number(i.atr14).toFixed(3);
        $("structure").textContent =
            i.market_structure || "Unavailable";

        $("indicatorTrend").textContent = i.trend || "UNKNOWN";
    }


    // AI ANALYSIS
    async function analyzeMarket() {
        const button = $("analyzeButton");

        button.disabled = true;
        button.textContent = "ANALYZING XAUUSD...";

        $("aiStatus").textContent = "AI analysis running";

        $("aiReasoning").textContent =
            "Analyzing M5, M15 and H1 market conditions...";

        try {
            const data = await api("/analyze-live", 60000);
            const a = data.analysis;

            if (!a) {
                throw new Error("AI response unavailable");
            }

            const decision = String(a.decision || "WAIT").toUpperCase();

            $("aiDecision").textContent = decision;
            $("aiDecision").className =
                "decision-display " + decision.toLowerCase();

            $("overviewDecision").textContent = decision;
            $("overviewAI").textContent = decision;

            $("overviewAI").className =
                "decision-display " + decision.toLowerCase();

            $("aiTrend").textContent = a.trend || "UNKNOWN";

            $("aiConfidence").textContent =
                `${a.confidence ?? "—"}%`;

            $("overviewConfidence").textContent =
                `${a.confidence ?? "—"}%`;

            $("overviewTrend").textContent = a.trend || "UNKNOWN";

            $("aiCandles").textContent = data.candle_count ?? "—";

            $("aiReasoning").textContent =
                a.reasoning || "No reasoning provided.";

            $("overviewReason").textContent =
                a.reasoning || "No reasoning provided.";

            $("aiWarning").textContent =
                a.risk_warning ||
                "AI analysis is not a guaranteed trading signal.";

            $("aiTimestamp").textContent =
                "Last analysis: " + new Date().toLocaleString();

            if (data.indicators) {
                updateIndicators(data.indicators);
            }

        } catch (error) {
            $("aiReasoning").textContent =
                "Analysis failed: " + error.message;

            console.error("AI:", error);

        } finally {
            button.disabled = false;
            button.textContent = "✦ ANALYZE XAUUSD";
        }
    }


    // BUTTON EVENTS
    $("refreshMarket").addEventListener("click", loadMarket);
    $("refreshIndicators").addEventListener("click", loadIndicators);
    $("analyzeButton").addEventListener("click", analyzeMarket);


    // RISK SLIDER
    $("riskPct").addEventListener("input", event => {
        $("riskValue").textContent = event.target.value + "%";
    });


    // INITIAL LOAD
    checkBackend();
    loadMarket();
    loadIndicators();

    // AUTOMATIC REFRESH
    setInterval(checkBackend, 30000);
    setInterval(loadMarket, 60000);
});
