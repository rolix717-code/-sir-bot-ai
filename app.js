const API_BASE = "https://sir-bot-ai-backend.rolix717.workers.dev";

document.addEventListener("DOMContentLoaded", () => {

    const $ = id => document.getElementById(id);

    const nav = $("nav");
    const menuBtn = $("menuBtn");
    const dialog = $("infoDialog");

    const connectBtn = $("connectBtn");
    const closeDialog = $("closeDialog");
    const okDialog = $("okDialog");

    const slider = $("riskPct");
    const riskValue = $("riskValue");

    const backendStatus = $("backendStatus");
    const backendMessage = $("backendMessage");

    const marketStatus = $("marketStatus");
    const goldPrice = $("goldPrice");
    const goldBid = $("goldBid");
    const goldAsk = $("goldAsk");
    const goldSpread = $("goldSpread");
    const marketUpdated = $("marketUpdated");
    const marketMessage = $("marketMessage");
    const refreshButton = $("refreshMarket");

    // NAVIGATION
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
    if (connectBtn && dialog) {
        connectBtn.addEventListener("click", () => {
            dialog.showModal();
        });
    }

    if (closeDialog && dialog) {
        closeDialog.addEventListener("click", () => dialog.close());
    }

    if (okDialog && dialog) {
        okDialog.addEventListener("click", () => dialog.close());
    }

    // RISK DISPLAY ONLY
    if (slider && riskValue) {
        slider.addEventListener("input", () => {
            riskValue.textContent = slider.value + "%";
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
                cache: "no-store",
                signal: controller.signal
            });

            const data = await res.json();

            if (!res.ok) {
                throw new Error(
                    data.details || data.error || `HTTP ${res.status}`
                );
            }

            return data;

        } finally {
            clearTimeout(timeout);
        }
    }

    // BACKEND STATUS
    async function checkBackend() {
        if (!backendStatus || !backendMessage) return;

        backendStatus.textContent = "CHECKING";

        try {
            const data = await fetchJSON(`${API_BASE}/health`);

            if (data.status !== "online") {
                throw new Error("Backend offline");
            }

            backendStatus.textContent = "BACKEND ONLINE";
            backendStatus.style.color = "#41d69b";

            backendMessage.textContent =
                "Cloudflare connected. AI: " +
                data.ai +
                ". Market data: " +
                data.market_data +
                ". Trading disabled.";

        } catch (error) {
            backendStatus.textContent = "BACKEND OFFLINE";
            backendStatus.style.color = "#e15b5b";
            backendMessage.textContent = error.message;
        }
    }

    // LIVE GOLD PRICE
    async function loadGoldPrice() {
        if (!marketStatus || !goldPrice) return;

        marketStatus.textContent = "CONNECTING";

        try {
            const data = await fetchJSON(
                `${API_BASE}/market-check?timeframe=M1`
            );

            if (!data.prices) {
                throw new Error("Market prices unavailable");
            }

            const p = data.prices;

            goldPrice.textContent = Number(p.close).toFixed(3);
            goldBid.textContent = Number(p.bid).toFixed(3);
            goldAsk.textContent = Number(p.ask).toFixed(3);

            const spread = Number(
                p.spread ?? (Number(p.ask) - Number(p.bid))
            );

            goldSpread.textContent = spread.toFixed(3);

            marketUpdated.textContent =
                new Date().toLocaleTimeString();

            marketStatus.textContent = "CONNECTED";
            marketStatus.style.color = "#41d69b";

            marketMessage.textContent =
                "Live XAUUSD market data connected.";

        } catch (error) {
            marketStatus.textContent = "OFFLINE";
            marketStatus.style.color = "#e15b5b";

            marketMessage.textContent =
                "Market error: " + error.message;
        }
    }

    // CREATE AI PANEL
    const panel = document.createElement("section");

    panel.id = "sirAiPanel";

    panel.style.cssText = `
        margin:25px 0;
        padding:22px;
        border:1px solid #303746;
        border-radius:16px;
        background:#111722;
        color:white;
        font-family:inherit;
    `;

    panel.innerHTML = `
        <h2 style="margin-top:0">SIR BOT AI ANALYSIS</h2>

        <p style="color:#9ca9bd">
            XAUUSD Intelligent Market Analysis
        </p>

        <div style="display:flex;gap:12px;flex-wrap:wrap">

            <div style="flex:1;min-width:110px">
                <small>MARKET</small>
                <h3>XAUUSD</h3>
            </div>

            <div style="flex:1;min-width:110px">
                <small>CANDLES</small>
                <h3 id="aiCandleCount">Not loaded</h3>
            </div>

            <div style="flex:1;min-width:110px">
                <small>AI STATUS</small>
                <h3 id="aiStatus">STANDBY</h3>
            </div>

        </div>

        <hr style="border-color:#303746">

        <small>AI DECISION</small>

        <h1 id="aiDecision" style="font-size:32px">
            WAITING
        </h1>

        <p>Confidence: <strong id="aiConfidence">--</strong></p>

        <p>Trend: <strong id="aiTrend">--</strong></p>

        <h3>AI Reasoning</h3>

        <p id="aiReasoning" style="line-height:1.6;color:#bdc7d8">
            Press ANALYZE to inspect the latest market candles.
        </p>

        <p id="aiWarning" style="color:#e9b75c">
            Trading execution is disabled.
        </p>

        <small id="aiTimestamp" style="color:#8492a8">
            No analysis performed yet.
        </small>

        <br><br>

        <button id="aiAnalyzeButton"
            style="
                width:100%;
                padding:15px;
                border:0;
                border-radius:10px;
                background:#6658ed;
                color:white;
                font-weight:bold;
                font-size:16px;
            ">
            ANALYZE XAUUSD
        </button>
    `;

    const marketAnchor = refreshButton || marketMessage || marketStatus;

    if (marketAnchor && marketAnchor.parentElement) {
        marketAnchor.parentElement.insertAdjacentElement(
            "afterend",
            panel
        );
    } else {
        document.body.appendChild(panel);
    }

    // AI ELEMENTS
    const aiCandleCount = $("aiCandleCount");
    const aiStatus = $("aiStatus");
    const aiDecision = $("aiDecision");
    const aiConfidence = $("aiConfidence");
    const aiTrend = $("aiTrend");
    const aiReasoning = $("aiReasoning");
    const aiWarning = $("aiWarning");
    const aiTimestamp = $("aiTimestamp");
    const aiAnalyzeButton = $("aiAnalyzeButton");

    // CHECK MARKET CANDLES
    async function checkCandles() {
        aiStatus.textContent = "LOADING";

        try {
            const data = await fetchJSON(
                `${API_BASE}/market-candles?timeframe=M1`
            );

            aiCandleCount.textContent =
                data.candle_count + " candles";

            aiStatus.textContent = "DATA READY";
            aiStatus.style.color = "#41d69b";

        } catch (error) {
            aiStatus.textContent = "DATA ERROR";
            aiStatus.style.color = "#e15b5b";

            aiCandleCount.textContent = "Unavailable";

            aiReasoning.textContent = error.message;
        }
    }

    // AI ANALYSIS
    async function analyzeMarket() {

        aiAnalyzeButton.disabled = true;
        aiAnalyzeButton.textContent = "ANALYZING...";
        aiStatus.textContent = "AI WORKING";

        aiReasoning.textContent =
            "Fetching genuine XAUUSD market candles and analyzing market structure...";

        try {
            const data = await fetchJSON(
                `${API_BASE}/analyze-live?timeframe=M1`
            );

            if (!data.analysis) {
                throw new Error("AI analysis unavailable");
            }

            const analysis = data.analysis;

            aiDecision.textContent = analysis.decision;
            aiConfidence.textContent =
                analysis.confidence + "%";

            aiTrend.textContent = analysis.trend;

            aiReasoning.textContent = analysis.reasoning;

            aiCandleCount.textContent =
                data.candle_count + " candles";

            aiStatus.textContent = "AI CONNECTED";
            aiStatus.style.color = "#41d69b";

            aiDecision.style.color =
                analysis.decision === "BUY"
                    ? "#41d69b"
                    : analysis.decision === "SELL"
                    ? "#e15b5b"
                    : "#e9b75c";

            aiWarning.textContent =
                analysis.risk_warning ||
                "AI analysis is not a guaranteed trading signal. Execution disabled.";

            aiTimestamp.textContent =
                "Last analysis: " + new Date().toLocaleString();

        } catch (error) {

            aiStatus.textContent = "ANALYSIS FAILED";
            aiStatus.style.color = "#e15b5b";

            aiReasoning.textContent = error.message;

        } finally {
            aiAnalyzeButton.disabled = false;
            aiAnalyzeButton.textContent = "ANALYZE XAUUSD";
        }
    }

    // BUTTONS
    if (refreshButton) {
        refreshButton.addEventListener("click", loadGoldPrice);
    }

    ai
