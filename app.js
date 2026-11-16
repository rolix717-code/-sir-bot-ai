const API_BASE = "https://sir-bot-ai-backend.rolix717.workers.dev";

const nav = document.getElementById('nav');

document.getElementById('menuBtn').addEventListener('click', () => {
    nav.classList.toggle('show');
});

nav.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => nav.classList.remove('show'));
});

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

// BACKEND CONNECTION
async function checkBackend() {
    const statusTitle = document.querySelector('.status-card h3');
    const statusText = document.querySelector('.status-card p');
    const statusDot = document.querySelector('.status-dot');

    try {
        const response = await fetch(`${API_BASE}/health`);
        const data = await response.json();

        if (!response.ok || data.status !== 'online') {
            throw new Error('Backend unavailable');
        }

        statusTitle.innerHTML =
            '<span class="status-dot" style="background:#41d69b"></span> Backend online';

        statusText.textContent =
            'Cloudflare backend responding. Tchavi is configured. Live data and MT5 trading are not connected.';

        console.log('SIR BOT AI backend:', data);

    } catch (error) {
        statusTitle.innerHTML =
            '<span class="status-dot" style="background:#e15b5b"></span> Backend offline';

        statusText.textContent =
            'Unable to reach the SIR BOT AI backend. Please try again.';
            
        console.error(error);
    }
}

checkBackend();
setInterval(checkBackend, 30000);
