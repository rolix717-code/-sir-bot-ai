const API_BASE =
"https://sir-bot-ai-backend.rolix717.workers.dev";

document.addEventListener("DOMContentLoaded", () => {

    const $ = id => document.getElementById(id);

    // NAVIGATION

    const nav = $("nav");
    const menuBtn = $("menuBtn");

    if (menuBtn && nav) {
        menuBtn.addEventListener("click", () => {
            nav.classList.toggle("open");
        });

        nav.querySelectorAll("a").forEach(link => {
            link.addEventListener("click", () => {
                nav.classList.remove("open");
            });
        });
    }


    // CONNECTION DIALOG

    const dialog = $("infoDialog");

    if ($("connectBtn") && dialog) {
        $("connectBtn").addEventListener("click", () => {
            dialog.showModal();
        });
    }

    if ($("closeDialog")) {
        $("closeDialog").addEventListener("click", () => {
            dialog.close();
        });
    }

    if ($("okDialog")) {
        $("okDialog").addEventListener("click", () => {
            dialog.close();
        });
    }


    // RISK SLIDER

    const slider = $("riskPct");

    if (slider) {
        slider.addEventListener("input", () => {
            $("riskValue").textContent =
                slider.value + "%";
        });
    }


    // API REQUEST

    async function fetchJSON(url) {

        const controller = new AbortController();

        const timeout = setTimeout(() => {
            controller.abort();
        }, 30000);

        try {

            const res = await fetch(url, {
                method: "GET",
                cache: "no-store",
                signal: controller.signal
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(
                    data.details ||
                    data.error ||
                    `HTTP ${res.status}`
                );
            }

            return data;

        } finally {
            clearTimeout(timeout);
        }
    }


    // BACKEND STATUS

    async function checkBackend() {

        const status = $("backendStatus");
        const message = $("backendMessage");

        status.textContent = "Checking connection";

        try {

            const data = await fetchJSON(
                `${API_BASE}/health`
            );

            if (data.status !== "online") {
                throw new Error("Backend is offline");
            }

            status.textContent = "● BACKEND ONLINE";
            status.style.color = "#41d69b";

            message.textContent =
                "Cloudflare connected | AI: " +
                data.ai +
                " | Market data: " +
                data.market_data +
                " | Trading: disabled";

        } catch (error) {

            status.textContent = "BACKEND OFFLINE";
            status.style.color = "#e15b5b";

            message.textContent = error.message;

        }
    }


    // LIVE GOLD PRICE

    async function loadGoldPrice() {

        $("marketStatus").textContent = "CONNECTING";

        try {

            const data = await fetchJSON(
                `${API_BASE}/market-check?timeframe=M1`
            );

            if (!data.prices) {
                throw new Error("Market data unavailable");
            }

            const p = data.prices;

            const close = Number(p.close);
            const bid = Number(p.bid);
            const ask = Number(p.ask);

            if (![close, bid, ask].every(Number.isFinite)) {
                throw new Error("Invalid price data");
            }

            $("goldPrice").textContent = close.toFixed(3);

            $("goldBid").textContent = bid.toFixed(3);

            $("goldAsk").textContent = ask.toFixed(3);

            $("goldSpread").textContent =
                (ask - bid).toFixed(3);

            $("marketUpdated").textContent =
                new Date().toLocaleTimeString();

            $("marketStatus").textContent = "CONNECTED";

            $("marketMessage").textContent =
                "XAUUSD market feed connected. Price data only.";

        } catch (error) {

            $("marketStatus").textContent = "OFFLINE";

            $("marketMessage").textContent =
                "Market error: " + error.message;

        }
    }


    // CANDLE DATA

    async function loadCandles() {

        $("aiCandles").textContent = "Loading...";

        try {

            const data = await fetchJSON(
                `${API_BASE}/market-candles?timeframe=M1`
            );

            $("aiCandles").textContent =
                data.candle_count + " candles";

            $("aiStatus").textContent =
                "Market data ready for AI analysis.";

        } catch (error) {

            $("aiCandles").textContent = "Unavailable";

            $("aiStatus").textContent =
                "Candle error: " + error.message;

        }
    }


    // AI ANALYSIS

    async function analyzeMarket() {

        const button = $("analyzeButton");

        button.disabled = true;
        button.textContent = "ANALYZING...";

        $("aiStatus").textContent =
            "SIR BOT AI is analyzing XAUUSD...";

        $("aiReasoning").textContent =
            "Fetching genuine market candles...";

        try {

            const data = await fetchJSON(
                `${API_BASE}/analyze-live?timeframe=M1`
            );

            if (!data.analysis) {
                throw new Error("No AI analysis returned");
            }

            const a = data.analysis;

            $("aiDecision").textContent = a.decision;

            $("aiConfidence").textContent =
                a.confidence + "%";

            $("aiTrend").textContent = a.trend;

            $("aiCandles").textContent =
                data.candle_count + " candles";

            $("aiReasoning").textContent =
                a.reasoning;

            $("aiWarning").textContent =
                a.risk_warning ||
                "AI analysis is not a guaranteed trading signal.";

            $("aiTimestamp").textContent =
                "Last analysis: " +
                new Date().toLocaleString();

            $("aiStatus").textContent =
                "AI ANALYSIS COMPLETED";

            $("aiDecision").style.color =
                a.decision === "BUY"
                    ? "#41d69b"
                    : a.decision === "SELL"
                    ? "#e15b5b"
                    : "#e9b75c";

        } catch (error) {

            $("aiStatus").textContent =
                "ANALYSIS FAILED";

            $("aiReasoning").textContent =
                error.message;

        } finally {

            button.disabled = false;
            button.textContent = "ANALYZE XAUUSD";

        }
    }


    // BUTTON EVENTS

    $("refreshMarket").addEventListener(
        "click",
        loadGoldPrice
    );

    $("analyzeButton").addEventListener(
        "click",
        analyzeMarket
    );


    // START SYSTEM

    checkBackend();
    loadGoldPrice();
    loadCandles();


    // AUTOMATIC REFRESH

    setInterval(checkBackend, 30000);

    setInterval(loadGoldPrice, 60000);

});
