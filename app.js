const API_BASE = "https://sir-bot-ai-backend.rolix717.workers.dev";

const nav = document.getElementById('nav');

document.getElementById('menuBtn').addEventListener('click', () => {
    nav.classList.toggle('open');
});

nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
    nav.classList.remove('open');
}));

const dialog = document.getElementById('infoDialog');

document.getElementById('connectBtn').addEventListener('click', () => {
    dialog.showModal();
});

document.getElementById('closeDialog').addEventListener('click', () => {
    dialog.close();
});

document.getElementById('okDialog').addEventListener('click', () => {
    dialog.close();
});

const slider = document.getElementById('riskPct');

slider.addEventListener('input', () => {
    document.getElementById('riskValue').textContent = slider.value + '%';
});

// SIR BOT AI BACKEND CONNECTION
async function checkBackend() {
    try {
        const response = await fetch(`${API_BASE}/health`);
        const data = await response.json();

        console.log("Backend response:", data);

        if (response.ok) {
            document.title = "SIR BOT AI - Backend Online";
            console.log("SIR BOT AI backend connected.");
        }
    } catch (error) {
        console.error("Backend connection failed:", error);
    }
}

checkBackend();
