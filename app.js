// FlyEye — app.js (punto 1: scheletro)
'use strict';

const VERSIONE = '0.1.0'; // deve coincidere con VERSIONE in sw.js

const $ = (id) => document.getElementById(id);

/* ---------- Navigazione tra schermate (con tasto Indietro di Android) ---------- */
const SCHERMATE = ['home', 'volo', 'scarica', 'impostazioni'];

function mostraSchermata() {
  const nome = location.hash.replace('#', '') || 'home';
  const scelta = SCHERMATE.includes(nome) ? nome : 'home';
  SCHERMATE.forEach((s) => $(s).classList.toggle('attiva', s === scelta));
  if (scelta === 'impostazioni') aggiornaStato();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', mostraSchermata);

/* ---------- Stato rete ---------- */
function aggiornaRete() {
  const chip = $('stato-rete');
  const online = navigator.onLine;
  chip.textContent = online ? 'Online' : 'Offline';
  chip.className = 'chip ' + (online ? 'online' : 'offline');
  $('i-rete').textContent = online ? 'Connesso' : 'Nessuna rete';
}
window.addEventListener('online', aggiornaRete);
window.addEventListener('offline', aggiornaRete);

/* ---------- Pannello "Stato dell'app" ---------- */
function siNo(el, valore, testoSi, testoNo) {
  el.textContent = valore ? testoSi : testoNo;
  el.className = valore ? 'si' : 'no';
}

async function aggiornaStato() {
  $('i-versione').textContent = VERSIONE;
  aggiornaRete();

  // Pronta senza rete = l'app intera è nella cache del service worker
  let pronta = false;
  if ('caches' in window) {
    try { pronta = !!(await caches.match('./index.html', { ignoreSearch: true })); }
    catch (e) { pronta = false; }
  }
  siNo($('i-offline'), pronta, 'Sì', 'Non ancora');

  const installata =
    window.matchMedia('(display-mode: fullscreen)').matches ||
    window.matchMedia('(display-mode: standalone)').matches;
  siNo($('i-installata'), installata, 'Sì', 'No (aperta nel browser)');

  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage } = await navigator.storage.estimate();
      $('i-spazio').textContent = (usage / 1024 / 1024).toFixed(1) + ' MB';
    } catch (e) { $('i-spazio').textContent = 'n.d.'; }
  } else {
    $('i-spazio').textContent = 'n.d.';
  }
}

/* ---------- Avvisi in basso ---------- */
let timerAvviso;
function avviso(testo, durataMs = 4000) {
  $('avviso').textContent = testo;
  clearTimeout(timerAvviso);
  if (durataMs) timerAvviso = setTimeout(() => { $('avviso').textContent = ''; }, durataMs);
}

/* ---------- Service worker ---------- */
if ('serviceWorker' in navigator) {
  const avevaController = !!navigator.serviceWorker.controller;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      avviso('Errore: modalità offline non attiva', 0);
    });
  });

  // Messaggi dal service worker
  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data && ev.data.tipo === 'cache-pronta') {
      avviso('App pronta per l\'uso senza rete');
      aggiornaStato();
    }
  });

  // Nuova versione installata: ricarica una volta per usarla
  let ricaricata = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!avevaController || ricaricata) return;
    ricaricata = true;
    location.reload();
  });
} else {
  avviso('Questo browser non supporta la modalità offline', 0);
}

/* ---------- Avvio ---------- */
aggiornaRete();
mostraSchermata();
