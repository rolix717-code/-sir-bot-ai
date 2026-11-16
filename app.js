const API_BASE = "https://sir-bot-ai-backend.rolix717.workers.dev";

// NAVIGATION
const nav = document.getElementById("nav");
const menuBtn = document.getElementById("menuBtn");

menuBtn.addEventListener("click", () => {
    nav.classList.toggle("open");
});

nav.querySelectorAll("a").forEach(link => {
    link.addEventListener("click", () => {
        nav.classList.remove("open");
    });
});

// CONNECTION DIALOG
const dialog = document.getElementById("infoDialog");

document.getElementById("connectBtn").addEventListener("click", () => {
    dialog.showModal();
});

document.getElementById("closeDialog").addEventListener("click", () => {
    dialog.close();
});

document.getElementById("okDialog").addEventListener("click", () => {
    dialog.close();
});

// RISK SLIDER
const slider = document.getElementById("riskPct");

slider.addEventListener("input", () => {
    document.getElementById("riskValue").textContent =
        slider.value + "%";
});

// BACKEND CONNECTION
async function checkBackend() {
    const statusTitle = document.querySelector(".status-card h3");
    const statusMessage = document.getElementById("backendMessage");

    try {
        const result = await fetch(`${API_BASE}/health`);
        const data = await result.json();

        if (!result.ok || data.status !== "online") {
            throw new Error("Backend unavailable");
        }

        statusTitle.innerHTML =
            '<span class="status-dot" style="background:#41d69b"></span> Backend online';

        statusMessage.textContent =
            "Cloudflare connected. Tchavi and market data configuration checked. MT5 execution disabled.";

    } catch (error) {
        statusTitle.innerHTML =
            '<span class="status-dot" style="background:#e15b5b"></span> Backend offline';

        statusMessage.textContent =
            "Unable to connect to SIR BOT AI backend.";
    }
}

// LIVE GOLD MARKET
async function loadGoldPrice() {

    const status = document.getElementById("marketStatus");
    const price = document.getElementById("goldPrice");
    const bid = document.getElementById("goldBid");
    const ask = document.getElementById("goldAsk");
    const spread = document.getElementById("goldSpread");
    const updated = document.getElementById("marketUpdated");
    const message = document.getElementById("marketMessage");

    try {

        const result = await fetch(
            `${API_BASE}/market-check?timeframe=M1`,
            { cache: "no-store" }
        );

        const data = await result.json();

        if (!result.ok || data.data_status !== "connected") {
            throw new Error(data.error || "Market unavailable");
        }

        const prices = data.prices;

        price.textContent = Number(prices.close).toFixed(3);
        bid.textContent = Number(prices.bid).toFixed(3);
        ask.textContent = Number(prices.ask).toFixed(3);
        spread.textContent = Number(prices.spread).toFixed(3);

        updated.textContent = new Date(
            data.received_at
        ).toLocaleTimeString();

        status.textContent = "CONNECTED";
        status.style.color = "#41d69b";

        message.textContent =
            "Live XAUUSD price feed connected. Last successful update shown above. Trading remains disabled.";

    } catch (error) {

        status.textContent = "OFFLINE";
        status.style.color = "#e15b5b";

        message.textContent =
            "Market update failed: " + error.message;

        console.error("Gold price error:", error);
    }
}

// INITIAL CONNECTIONS
checkBackend();
loadGoldPrice();

// AUTOMATIC REFRESH EVERY 60 SECONDS
setInterval(checkBackend, 30000);
setInterval(loadGoldPrice, 60000);
