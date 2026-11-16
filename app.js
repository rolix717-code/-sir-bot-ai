const nav = document.getElementById('nav');
document.getElementById('menuBtn').addEventListener('click', () => nav.classList.toggle('show'));
nav.querySelectorAll('a').forEach(a => a.addEventListener('click', () => nav.classList.remove('show')));
const dialog = document.getElementById('infoDialog');
document.getElementById('connectBtn').addEventListener('click', () => dialog.showModal());
document.getElementById('closeDialog').addEventListener('click', () => dialog.close());
document.getElementById('okDialog').addEventListener('click', () => dialog.close());
const slider = document.getElementById('riskPct');
slider.addEventListener('input', () => {
  document.getElementById('riskValue').textContent = `${Number(slider.value).toFixed(2).replace(/0+$/,'').replace(/\.$/,'')}%`;
});
