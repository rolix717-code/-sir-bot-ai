const API_BASE = "https://sir-bot-ai-backend.rolix717.workers.dev";

document.addEventListener("DOMContentLoaded", () => {

    // ELEMENTS
    const nav = document.getElementById("nav");
    const menuBtn = document.getElementById("menuBtn");
    const dialog = document.getElementById("infoDialog");

    const connectBtn = document.getElementById("connectBtn");
    const closeDialog = document.getElementById("closeDialog");
    const okDialog = document.getElementById("okDialog");

    const slider = document.getElementById("riskPct");
    const riskValue = document.getElementById("riskValue");

    const backendStatus = document.getElementById("backendStatus");
    const backendMessage = document.getElementById("backendMessage");

    const marketStatus = document.getElementById("marketStatus");
    const goldPrice = document.getElementById("goldPrice");
    const goldBid = document.getElementById("goldBid");
    const goldAsk = document.getElementById("goldAsk");
    const goldSpread = document.getElementById("goldSpread");
    const marketUpdated = document.getElementById("marketUpdated");
    const marketMessage = document.getElementById("marketMessage");
    const refreshButton = document.getElementById("refreshMarket");

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
        closeDialog.addEventListener("click", () => {
            dialog.close();
        });
    }

    if (okDialog && dialog) {
        okDialog.addEventListener("click", () => {
            dialog.close();
        });
    }

    // RISK SLIDER
    if (slider && riskValue) {
        slider.addEventListener("input", () => {
            riskValue.textContent = slider.value + "%";
        });
    }

    // FETCH WITH TIMEOUT
    async function fetchJSON(url) {
        const controller = new AbortController();

        const timeout = setTimeout(() => {
            controller.abort();
        }, 12000);

        try {
            const response = await fetch(url, {
                method: "GET",
                cache: "no-store",
                signal: controller.signal
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(
                    data.error || `HTTP error ${response.status}`
                );
            }

            return data;

        } finally {
            clearTimeout(timeout);
        }
    }

    // BACKEND CONNECTION
    async function checkBackend() {

        if (!backendStatus || !backendMessage) return;

        backendStatus.textContent = "Checking connection";
        backendMessage.textContent = "Contacting Cloudflare backend...";

        try {
            const data = await fetchJSON(`${API_BASE}/health`);

            if (data.status !== "online") {
                throw new Error("Backend did not report online status");
            }

            backendStatus.innerHTML =
                '<span class="status-dot" style="background:#41d69b"></span> Backend online';

            backendMessage.textContent =
                "Cloudflare backend responding. MT5 execution remains disabled.";

        } catch (error) {

            backendStatus.textContent = "Backend connection failed";

            backendMessage.textContent =
                error.name === "AbortError"
                    ? "Backend request timed out."
                    : error.message;

            console.error("Backend error:", error);
        }
    }

    // LIVE GOLD PRICE
    async function loadGoldPrice() {

        if (!marketStatus || !goldPrice) return;

        marketStatus.textContent = "CONNECTING";
        marketMessage.textContent = "Requesting XAUUSD market data...";

        try {

            const data = await fetchJSON(
                `${API_BASE}/market-check?timeframe=M1`
            );

            if (data.data_status !== "connected" || !data.prices) {
                throw new Error(data.error || "Market data unavailable");
            }

            const prices = data.prices;

            const close = Number(prices.close);
            const bid = Number(prices.bid);
            const ask = Number(prices.ask);
            const spread = Number(prices.spread);

            if (![close, bid, ask, spread].every(Number.isFinite)) {
                throw new Error("Market provider returned invalid prices");
            }

            goldPrice.textContent = close.toFixed(3);
            goldBid.textContent = bid.toFixed(3);
            goldAsk.textContent = ask.toFixed(3);
            goldSpread.textContent = spread.toFixed(3);

            marketUpdated.textContent = data.received_at
                ? new Date(data.received_at).toLocaleTimeString()
                : new Date().toLocaleTimeString();

            marketStatus.textContent = "CONNECTED";
            marketStatus.style.color = "#41d69b";

            marketMessage.textContent =
                "XAUUSD price feed responding. This is price data only, not a trading signal.";

        } catch (error) {

            marketStatus.textContent = "OFFLINE";
            marketStatus.style.color = "#e15b5b";

            marketMessage.textContent =
                error.name === "AbortError"
                    ? "Market request timed out."
                    : "Market error: " + error.message;

            console.error("Market data error:", error);
        }
    }

    // MANUAL REFRESH
    if (refreshButton) {
        refreshButton.addEventListener("click", () => {
            loadGoldPrice();
        });
    }

    // START CONNECTIONS
    checkBackend();
    loadGoldPrice();

    // AUTOMATIC UPDATES
    setInterval(checkBackend, 30000);
    setInterval(loadGoldPrice, 60000);

});
