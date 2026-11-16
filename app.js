// FlyEye — app.js (punti 2 e 3: GPS, strumenti, simulatore, schermata Scarica)
// Altri file: archivio.js (dati offline), mappa.js (mappa). Vanno caricati prima di questo.
'use strict';

const VERSIONE = '0.3.0'; // deve coincidere con VERSIONE in sw.js

const $ = (id) => document.getElementById(id);

/* =====================================================================
   GEOGRAFIA (calcoli sulla sfera terrestre)
   ===================================================================== */
const R_TERRA = 6371008.8; // metri
const rad = (g) => g * Math.PI / 180;
const deg = (r) => r * 180 / Math.PI;

// Distanza in metri tra due punti {lat, lon}
function distanza(a, b) {
  const f1 = rad(a.lat), f2 = rad(b.lat);
  const df = f2 - f1, dl = rad(b.lon - a.lon);
  const h = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return 2 * R_TERRA * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Direzione iniziale da a verso b, in gradi 0–360 (0 = nord)
function rotta(a, b) {
  const f1 = rad(a.lat), f2 = rad(b.lat), dl = rad(b.lon - a.lon);
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// Punto sulla rotta più breve (ortodromia) da a a b; fr da 0 a 1
function puntoIntermedio(a, b, fr) {
  const d = distanza(a, b) / R_TERRA;
  if (d === 0) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - fr) * d) / Math.sin(d);
  const B = Math.sin(fr * d) / Math.sin(d);
  const f1 = rad(a.lat), l1 = rad(a.lon), f2 = rad(b.lat), l2 = rad(b.lon);
  const x = A * Math.cos(f1) * Math.cos(l1) + B * Math.cos(f2) * Math.cos(l2);
  const y = A * Math.cos(f1) * Math.sin(l1) + B * Math.cos(f2) * Math.sin(l2);
  const z = A * Math.sin(f1) + B * Math.sin(f2);
  return { lat: deg(Math.atan2(z, Math.hypot(x, y))), lon: deg(Math.atan2(y, x)) };
}

// Punto raggiunto partendo da a, in direzione dir (gradi), per metri
function puntoDa(a, dir, metri) {
  const d = metri / R_TERRA, t = rad(dir), f1 = rad(a.lat), l1 = rad(a.lon);
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(f1),
                             Math.cos(d) - Math.sin(f1) * Math.sin(f2));
  return { lat: deg(f2), lon: ((deg(l2) + 540) % 360) - 180 };
}

function cardinale(g) {
  const nomi = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  return nomi[Math.round(g / 45) % 8];
}

/* =====================================================================
   AEROPORTI E TRATTE
   Per aggiungere una tratta: aggiungere gli aeroporti mancanti qui sotto
   e una riga in TRATTE. Ogni tratta vale nei due sensi.
   ===================================================================== */
const AEROPORTI = {
  CTA: { nome: 'Catania', lat: 37.4668, lon: 15.0664, quota: 12 },
  PMO: { nome: 'Palermo', lat: 38.1760, lon: 13.0910, quota: 20 },
  VRN: { nome: 'Verona',  lat: 45.3957, lon: 10.8885, quota: 73 }
};

const TRATTE = [
  { a: 'CTA', b: 'VRN' },
  { a: 'PMO', b: 'VRN' }
];

// Tutti i sensi di volo: CTA-VRN, VRN-CTA, PMO-VRN, VRN-PMO
function direzioniVolo() {
  return TRATTE.flatMap((t) => [
    { id: t.a + '-' + t.b, da: t.a, a: t.b },
    { id: t.b + '-' + t.a, da: t.b, a: t.a }
  ]);
}

/* =====================================================================
   MOTORE POSIZIONE
   Unica fonte da cui leggono tutte le viste (strumenti ora, mappa dopo).
   Riceve i dati dal GPS vero o dal simulatore.
   Dato: { lat, lon, quota, velocita (m/s), direzione (gradi), precisione (m),
           precisioneQuota, ricevuto (ms), origine: 'gps'|'sim',
           velocitaCalcolata, direzioneCalcolata }
   ===================================================================== */
const SOGLIA_VECCHIO = 5000;  // ms: oltre, l'età del dato diventa arancione
const SOGLIA_PERSO = 15000;   // ms: oltre, il GPS è considerato PERSO

const Motore = {
  sorgente: null,      // 'gps' | 'sim'
  dato: null,          // ultimo dato ricevuto
  errore: null,        // { tipo, testo }
  inizioAttesa: 0,     // quando è iniziata l'attesa del primo dato GPS
  ascoltatori: [],

  iscriviti(fn) { this.ascoltatori.push(fn); },
  avvisa() { this.ascoltatori.forEach((fn) => fn(this.dato, this.stato())); },

  ricevi(dato) {
    this.dato = dato;
    if (this.errore && this.errore.tipo !== 'negato') this.errore = null;
    this.avvisa();
  },

  segnalaErrore(tipo, testo) {
    this.errore = { tipo, testo };
    this.avvisa();
  },

  imposta(sorgente) {
    if (sorgente === this.sorgente) return;
    if (this.sorgente === 'gps') GPS.ferma();
    if (this.sorgente === 'sim') Sim.pausa();
    this.sorgente = sorgente;
    this.dato = null;
    this.errore = null;
    if (sorgente === 'sim') {
      if (!Sim.st) Sim.prepara(); else Sim.emetti();
    }
    this.avvisa();
  },

  // SPENTO, IN ATTESA, REALE, PERSO, NEGATO, SIMULATO, PAUSA, ARRIVATO
  stato() {
    if (this.sorgente === 'sim') {
      if (!Sim.st) return 'SPENTO';
      if (Sim.timer) return 'SIMULATO';
      return Sim.st.fase === 'arrivato' ? 'ARRIVATO' : 'PAUSA';
    }
    if (this.sorgente === 'gps') {
      if (this.errore && this.errore.tipo === 'negato') return 'NEGATO';
      if (!GPS.attivo()) return 'SPENTO';
      if (!this.dato) return 'IN ATTESA';
      return (Date.now() - this.dato.ricevuto) > SOGLIA_PERSO ? 'PERSO' : 'REALE';
    }
    return 'SPENTO';
  }
};

/* =====================================================================
   GPS VERO
   ===================================================================== */
const GPS = {
  id: null,
  prec: null,   // dato precedente
  rif: null,    // ultimo punto usato per calcolare la direzione

  attivo() { return this.id !== null; },

  avvia() {
    if (!('geolocation' in navigator)) {
      Motore.segnalaErrore('assente', 'Questo browser non dà accesso alla posizione.');
      return;
    }
    if (this.id !== null) return;
    this.prec = null;
    this.rif = null;
    Motore.dato = null;
    Motore.errore = null;
    Motore.inizioAttesa = Date.now();
    this.id = navigator.geolocation.watchPosition(
      (p) => this.posizione(p),
      (e) => this.errore(e),
      { enableHighAccuracy: true, maximumAge: 0 }
    );
    Motore.avvisa();
  },

  ferma() {
    if (this.id !== null) navigator.geolocation.clearWatch(this.id);
    this.id = null;
    Motore.avvisa();
  },

  posizione(p) {
    if (Motore.sorgente !== 'gps') return;
    const c = p.coords;
    const ora = Date.now();
    const d = {
      lat: c.latitude,
      lon: c.longitude,
      quota: (c.altitude === null || isNaN(c.altitude)) ? null : c.altitude,
      precisione: c.accuracy,
      precisioneQuota: c.altitudeAccuracy ?? null,
      velocita: null,
      direzione: null,
      ricevuto: ora,
      origine: 'gps',
      velocitaCalcolata: false,
      direzioneCalcolata: false
    };
    const prec = this.prec;

    // Velocità: dal GPS; se manca, calcolata dallo spostamento
    if (c.speed !== null && !isNaN(c.speed)) {
      d.velocita = c.speed;
    } else if (prec) {
      const dt = (ora - prec.ricevuto) / 1000;
      if (dt >= 0.5 && dt <= 30) {
        d.velocita = distanza(prec, d) / dt;
        d.velocitaCalcolata = true;
      }
    }

    // Direzione: dal GPS se in movimento; altrimenti calcolata
    // quando ci si è spostati di almeno 25 m; da fermi resta l'ultima
    const inMoto = (d.velocita ?? 0) > 1;
    if (c.heading !== null && !isNaN(c.heading) && inMoto) {
      d.direzione = c.heading;
      this.rif = d;
    } else if (this.rif && inMoto && distanza(this.rif, d) > 25) {
      d.direzione = rotta(this.rif, d);
      d.direzioneCalcolata = true;
      this.rif = d;
    } else {
      if (!this.rif) this.rif = d;
      if (prec) {
        d.direzione = prec.direzione;
        d.direzioneCalcolata = prec.direzioneCalcolata;
      }
    }

    this.prec = d;
    Motore.ricevi(d);
  },

  errore(e) {
    if (e.code === 1) {
      this.ferma();
      Motore.segnalaErrore('negato',
        'Permesso posizione negato. In Chrome: ⋮ → Impostazioni → Impostazioni sito → ' +
        'Posizione → consenti pablobongo.github.io. Poi premi di nuovo Avvia GPS.');
    } else if (e.code === 2) {
      Motore.segnalaErrore('non-disponibile',
        'Posizione non disponibile: controlla che la Posizione del telefono sia attiva.');
    }
    // code 3 (timeout) non si verifica: non è impostato alcun timeout
  }
};

/* =====================================================================
   SIMULATORE
   Volo finto lungo la rotta più breve tra i due aeroporti, con fasi
   realistiche. Valori indicativi, non presi da voli veri.
   ===================================================================== */
const SIM = {
  vRullaggio: 6,          // m/s (≈22 km/h)
  tRullaggio: 240,        // s di rullaggio in partenza
  accDecollo: 2.0,        // m/s² in corsa di decollo
  vRotazione: 80,         // m/s (≈290 km/h) stacco da terra
  vSalita: 11,            // m/s di salita (≈17 min fino in crociera)
  quotaCrociera: 11000,   // m
  vCrociera: 230,         // m/s (≈830 km/h)
  pendenzaDiscesa: 18,    // metri in orizzontale per ogni metro di discesa
  vAvvicinamento: 72,     // m/s (≈260 km/h) all'atterraggio
  decAtterraggio: 1.8,    // m/s² in frenata
  tRullaggioArrivo: 180   // s di rullaggio all'arrivo
};

const MOLTIPLICATORI = [1, 10, 30, 60];

const NOMI_FASE = {
  'rullaggio': 'Rullaggio',
  'decollo': 'Decollo',
  'salita': 'Salita',
  'crociera': 'Crociera',
  'discesa': 'Discesa',
  'atterraggio': 'Atterraggio',
  'rullaggio-arrivo': 'Rullaggio all\'arrivo',
  'arrivato': 'Arrivato'
};

const Sim = {
  direzione: 'CTA-VRN',
  moltiplicatore: 10,
  timer: null,
  st: null,

  prepara() {
    const [da, a] = this.direzione.split('-');
    const A = AEROPORTI[da], B = AEROPORTI[a];
    const D = distanza(A, B);
    this.st = {
      A, B, D,
      dirFinale: rotta(puntoIntermedio(A, B, 0.999), B),
      s: 0,              // metri percorsi
      quota: A.quota,
      v: 0,
      fase: 'rullaggio',
      tFase: 0,
      tSim: 0            // secondi di volo simulato
    };
    this.emetti();
  },

  scegliDirezione(id) {
    const eraInCorso = !!this.timer;
    this.pausa();
    this.direzione = id;
    this.prepara();
    if (eraInCorso) this.avvia();
  },

  avvia() {
    if (this.timer) return;
    if (!this.st || this.st.fase === 'arrivato') this.prepara();
    this.timer = setInterval(() => this.tick(), 1000);
    Motore.avvisa();
  },

  pausa() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    Motore.avvisa();
  },

  ricomincia() {
    this.pausa();
    this.prepara();
  },

  tick() {
    for (let i = 0; i < this.moltiplicatore; i++) {
      this.passo(1);
      if (this.st.fase === 'arrivato') break;
    }
    if (this.st.fase === 'arrivato') {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.emetti();
  },

  cambia(fase) { this.st.fase = fase; this.st.tFase = 0; },

  // Avanza la simulazione di dt secondi
  passo(dt) {
    const st = this.st, P = SIM;

    switch (st.fase) {
      case 'rullaggio':
        st.v = P.vRullaggio;
        st.tFase += dt;
        if (st.tFase >= P.tRullaggio) this.cambia('decollo');
        break;
      case 'decollo':
        st.v = Math.min(P.vRotazione, st.v + P.accDecollo * dt);
        if (st.v >= P.vRotazione) this.cambia('salita');
        break;
      case 'salita': {
        st.quota = Math.min(P.quotaCrociera, st.quota + P.vSalita * dt);
        const fr = (st.quota - st.A.quota) / (P.quotaCrociera - st.A.quota);
        st.v = P.vRotazione + (P.vCrociera - P.vRotazione) * fr;
        if (st.quota >= P.quotaCrociera) this.cambia('crociera');
        break;
      }
      case 'crociera':
        st.v = P.vCrociera;
        break;
      case 'atterraggio':
        st.v = Math.max(P.vRullaggio, st.v - P.decAtterraggio * dt);
        if (st.v <= P.vRullaggio) this.cambia('rullaggio-arrivo');
        break;
      case 'rullaggio-arrivo':
        st.v = P.vRullaggio;
        st.tFase += dt;
        if (st.tFase >= P.tRullaggioArrivo) { st.v = 0; this.cambia('arrivato'); }
        break;
      case 'arrivato':
        st.v = 0;
        break;
    }

    st.s += st.v * dt;
    st.tSim += dt;

    // Discesa: quota massima consentita per arrivare all'aeroporto
    const restante = st.D - st.s;
    const quotaProfilo = st.B.quota + Math.max(0, restante / P.pendenzaDiscesa);
    if ((st.fase === 'salita' || st.fase === 'crociera') && quotaProfilo < st.quota) {
      this.cambia('discesa');
    }
    if (st.fase === 'discesa') {
      st.quota = Math.min(st.quota, quotaProfilo);
      const fr = (st.quota - st.B.quota) / (P.quotaCrociera - st.B.quota);
      st.v = P.vAvvicinamento + (P.vCrociera - P.vAvvicinamento) * Math.max(0, fr);
      if (restante <= 0) {
        st.quota = st.B.quota;
        this.cambia('atterraggio');
      }
    }
  },

  posizione() {
    const st = this.st;
    if (st.s <= st.D) return puntoIntermedio(st.A, st.B, st.s / st.D);
    return puntoDa(st.B, st.dirFinale, st.s - st.D);
  },

  emetti() {
    if (Motore.sorgente !== 'sim' || !this.st) return;
    const st = this.st;
    const p = this.posizione();
    const dir = (st.D - st.s) > 200 ? rotta(p, st.B) : st.dirFinale;
    Motore.ricevi({
      lat: p.lat,
      lon: p.lon,
      quota: st.quota,
      velocita: st.v,
      direzione: dir,
      precisione: 5,
      precisioneQuota: 10,
      ricevuto: Date.now(),
      origine: 'sim',
      velocitaCalcolata: false,
      direzioneCalcolata: false
    });
  }
};

/* =====================================================================
   SCHERMO SEMPRE ACCESO (Wake Lock)
   Attivo nella schermata Volo e durante un download di mappe.
   ===================================================================== */
const Schermo = {
  lock: null,
  voluto: false,
  erroreRichiesta: false,

  attiva() { this.voluto = true; this.richiedi(); },

  async richiedi() {
    if (!('wakeLock' in navigator)) { this.mostra(); return; }
    if (this.lock || !this.voluto || document.visibilityState !== 'visible') return;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.erroreRichiesta = false;
      this.lock.addEventListener('release', () => { this.lock = null; this.mostra(); });
    } catch (e) {
      this.lock = null;
      this.erroreRichiesta = true;
    }
    this.mostra();
  },

  disattiva() {
    this.voluto = false;
    if (this.lock) this.lock.release().catch(() => {});
    this.lock = null;
    this.mostra();
  },

  mostra() {
    const el = $('wake');
    if (!el) return;
    if (!('wakeLock' in navigator)) el.textContent = 'Schermo sempre acceso: non supportato';
    else if (this.lock) el.textContent = 'Schermo sempre acceso: sì';
    else if (this.erroreRichiesta) el.textContent = 'Schermo sempre acceso: no (risparmio energetico attivo?)';
    else el.textContent = 'Schermo sempre acceso: no';
  }
};

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Schermo.voluto) Schermo.richiedi();
});

// Decide se lo schermo deve restare acceso (schermata Volo o download in corso)
function aggiornaSchermoAcceso() {
  const nome = location.hash.replace('#', '') || 'home';
  if (nome === 'volo' || Scaricatore.inCorso) Schermo.attiva(); else Schermo.disattiva();
}

/* =====================================================================
   IMPOSTAZIONI SALVATE (scelta sorgente, tratta, velocità simulatore)
   ===================================================================== */
const CHIAVE_IMPOSTAZIONI = 'flyeye-impostazioni';

function leggiImpostazioni() {
  try { return JSON.parse(localStorage.getItem(CHIAVE_IMPOSTAZIONI)) || {}; }
  catch (e) { return {}; }
}

function salvaImpostazioni() {
  try {
    localStorage.setItem(CHIAVE_IMPOSTAZIONI, JSON.stringify({
      sorgente: Motore.sorgente,
      direzione: Sim.direzione,
      moltiplicatore: Sim.moltiplicatore
    }));
  } catch (e) { /* spazio non disponibile: si ignora */ }
}

/* =====================================================================
   FORMATI
   ===================================================================== */
const num = (n) => n.toLocaleString('it-IT');

function durata(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const due = (x) => String(x).padStart(2, '0');
  return h > 0 ? h + ':' + due(m) + ':' + due(s) : m + ':' + due(s);
}

function coordinate(d) {
  const lat = Math.abs(d.lat).toFixed(5) + '° ' + (d.lat >= 0 ? 'N' : 'S');
  const lon = Math.abs(d.lon).toFixed(5) + '° ' + (d.lon >= 0 ? 'E' : 'O');
  return lat + '   ' + lon;
}

// Byte in testo leggibile: "12,3 MB", "1,4 GB"
function peso(byte) {
  if (byte === null || byte === undefined || isNaN(byte)) return 'n.d.';
  const mb = byte / 1024 / 1024;
  if (mb >= 1024) return (mb / 1024).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + ' GB';
  return mb.toLocaleString('it-IT', { maximumFractionDigits: 1 }) + ' MB';
}

/* =====================================================================
   SCHERMATA VOLO
   ===================================================================== */
const STATI = {
  'SPENTO':    ['SPENTO', 'spento'],
  'IN ATTESA': ['IN ATTESA', 'attesa'],
  'REALE':     ['REALE', 'reale'],
  'PERSO':     ['PERSO', 'perso'],
  'NEGATO':    ['GPS NEGATO', 'perso'],
  'SIMULATO':  ['SIMULATO', 'simulato'],
  'PAUSA':     ['SIMULATORE IN PAUSA', 'pausa'],
  'ARRIVATO':  ['SIMULATORE: ARRIVATO', 'pausa']
};

function etichetta(id, testo, classe) {
  const e = $(id);
  e.textContent = testo;
  e.className = 'orig ' + (classe || '');
}

function aggiornaStrumenti() {
  const stato = Motore.stato();
  const d = Motore.dato;
  const ora = Date.now();

  // Indicatore di stato
  const [testo, classe] = STATI[stato];
  $('stato-pos').textContent = stato === 'IN ATTESA'
    ? testo + ' · ' + durata((ora - Motore.inizioAttesa) / 1000)
    : testo;
  $('stato-pos').className = 'stato-pos ' + classe;

  // Messaggio sotto l'indicatore
  let msg = Motore.errore ? Motore.errore.testo : '';
  if (!msg && stato === 'IN ATTESA' && ora - Motore.inizioAttesa > 60000) {
    msg = 'Nessun segnale finora: avvicinati al finestrino o all\'aperto. ' +
          'Senza rete il primo aggancio può richiedere alcuni minuti.';
  }
  if (!msg && stato === 'PERSO') {
    msg = 'Segnale GPS perso: i valori mostrati sono gli ultimi ricevuti.';
  }
  $('msg-pos').textContent = msg;

  $('strumenti').classList.toggle('vecchio', stato === 'PERSO');

  const o = d ? (d.origine === 'sim' ? ['SIM', 'sim'] : ['GPS', 'gps']) : ['', ''];

  // Velocità
  if (d && d.velocita !== null) {
    $('s-vel').textContent = num(Math.round(d.velocita * 3.6));
    etichetta('o-vel', d.velocitaCalcolata ? 'GPS calc.' : o[0], o[1]);
  } else { $('s-vel').textContent = '—'; etichetta('o-vel', ''); }

  // Quota
  if (d && d.quota !== null) {
    $('s-quota').textContent = num(Math.round(d.quota));
    etichetta('o-quota', o[0], o[1]);
  } else { $('s-quota').textContent = '—'; etichetta('o-quota', ''); }

  // Direzione
  if (d && d.direzione !== null) {
    const g = Math.round(d.direzione) % 360;
    $('s-dir').textContent = String(g).padStart(3, '0') + '°';
    $('s-dir-card').textContent = cardinale(g);
    etichetta('o-dir', d.direzioneCalcolata ? 'GPS calc.' : o[0], o[1]);
  } else {
    $('s-dir').textContent = '—';
    $('s-dir-card').textContent = '';
    etichetta('o-dir', '');
  }

  // Precisione
  const ep = $('s-prec');
  if (d) {
    ep.textContent = '± ' + num(Math.round(d.precisione));
    ep.className = d.precisione <= 20 ? 'c-ok' : (d.precisione <= 100 ? 'c-att' : 'c-err');
    etichetta('o-prec', o[0], o[1]);
  } else { ep.textContent = '—'; ep.className = ''; etichetta('o-prec', ''); }

  // Coordinate
  if (d) { $('s-coord').textContent = coordinate(d); etichetta('o-coord', o[0], o[1]); }
  else { $('s-coord').textContent = '—'; etichetta('o-coord', ''); }

  // Età dell'ultimo dato
  const ee = $('s-eta');
  if (d) {
    const eta = ora - d.ricevuto;
    const sec = Math.floor(eta / 1000);
    ee.textContent = sec < 1 ? 'adesso' : (sec < 60 ? sec + ' s fa' : durata(sec) + ' fa');
    const ferma = d.origine === 'sim' && !Sim.timer; // simulatore in pausa: non è un problema
    ee.className = ferma ? '' : (eta <= SOGLIA_VECCHIO ? 'c-ok' : (eta <= SOGLIA_PERSO ? 'c-att' : 'c-err'));
  } else { ee.textContent = '—'; ee.className = ''; }

  // Pannelli e tasti
  const sim = Motore.sorgente === 'sim';
  $('btn-src-gps').classList.toggle('attivo', !sim);
  $('btn-src-sim').classList.toggle('attivo', sim);
  $('pannello-gps').hidden = sim;
  $('pannello-sim').hidden = !sim;

  const bg = $('btn-gps');
  bg.textContent = GPS.attivo() ? 'Ferma GPS' : 'Avvia GPS';
  bg.classList.toggle('ferma', GPS.attivo());

  if (sim) aggiornaPannelloSim();
}

function aggiornaPannelloSim() {
  const st = Sim.st;
  if (!st) return;
  $('sim-fase').textContent = NOMI_FASE[st.fase];
  $('sim-dist').textContent =
    num(Math.round(Math.min(st.s, st.D) / 1000)) + ' / ' + num(Math.round(st.D / 1000)) + ' km';
  $('sim-tempo').textContent = durata(st.tSim);
  $('sim-barra').style.width = (100 * Math.min(1, st.s / st.D)).toFixed(1) + '%';

  const play = $('btn-sim-play');
  if (Sim.timer) play.textContent = 'Pausa';
  else if (st.fase === 'arrivato') play.textContent = 'Rifai il volo';
  else play.textContent = st.tSim > 0 ? 'Riprendi' : 'Avvia';

  document.querySelectorAll('#sim-tratte .scelta').forEach((b) =>
    b.classList.toggle('attivo', b.dataset.dir === Sim.direzione));
  document.querySelectorAll('#sim-vel .scelta').forEach((b) =>
    b.classList.toggle('attivo', Number(b.dataset.molt) === Sim.moltiplicatore));
}

function preparaSchermataVolo() {
  // Tasti delle tratte simulate
  direzioniVolo().forEach((d) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'scelta';
    b.dataset.dir = d.id;
    b.textContent = AEROPORTI[d.da].nome + ' → ' + AEROPORTI[d.a].nome;
    b.addEventListener('click', () => {
      Sim.scegliDirezione(d.id);
      salvaImpostazioni();
      aggiornaStrumenti();
    });
    $('sim-tratte').appendChild(b);
  });

  // Tasti della velocità del simulatore
  MOLTIPLICATORI.forEach((m) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'scelta';
    b.dataset.molt = m;
    b.textContent = m + 'x';
    b.addEventListener('click', () => {
      Sim.moltiplicatore = m;
      salvaImpostazioni();
      aggiornaStrumenti();
    });
    $('sim-vel').appendChild(b);
  });

  $('btn-src-gps').addEventListener('click', () => { Motore.imposta('gps'); salvaImpostazioni(); });
  $('btn-src-sim').addEventListener('click', () => { Motore.imposta('sim'); salvaImpostazioni(); });

  $('btn-gps').addEventListener('click', () => {
    if (GPS.attivo()) GPS.ferma(); else GPS.avvia();
  });

  $('btn-sim-play').addEventListener('click', () => {
    if (Sim.timer) Sim.pausa(); else Sim.avvia();
  });
  $('btn-sim-reset').addEventListener('click', () => Sim.ricomincia());

  // Ripristina le scelte dell'ultima volta (il GPS non parte da solo)
  const imp = leggiImpostazioni();
  if (direzioniVolo().some((d) => d.id === imp.direzione)) Sim.direzione = imp.direzione;
  if (MOLTIPLICATORI.includes(imp.moltiplicatore)) Sim.moltiplicatore = imp.moltiplicatore;

  Motore.iscriviti(aggiornaStrumenti);
  Motore.imposta(imp.sorgente === 'sim' ? 'sim' : 'gps');

  // Aggiorna ogni secondo l'età del dato e lo stato (REALE → PERSO)
  setInterval(aggiornaStrumenti, 1000);
}

/* =====================================================================
   SCHERMATA SCARICA TRATTA (punto 3: archivio e zona di prova)
   ===================================================================== */
const UIScarica = {
  confermaElimina: 0,     // ora del primo tocco su Elimina (serve il secondo entro 4 s)
  ultimoDisegno: 0,

  prepara() {
    $('z-fonte').textContent = FONTI[ZONA_PROVA.fonte].nome;

    $('btn-z-scarica').addEventListener('click', () => this.premiScarica());
    $('btn-z-conferma').addEventListener('click', () => {
      $('z-stima').hidden = true;
      Scaricatore.avvia(ZONA_PROVA);
    });
    $('btn-z-annulla').addEventListener('click', () => { $('z-stima').hidden = true; });
    $('btn-z-elimina').addEventListener('click', () => this.premiElimina());
    $('btn-persist').addEventListener('click', async () => {
      const ok = await Archivio.chiediPersistenza();
      avviso(ok ? 'Dati protetti dalla pulizia automatica' :
        'Chrome non ha concesso la protezione: installa l\'app dalla schermata Home e riprova');
      this.aggiornaArchivio();
    });
    $('btn-mappa-centra').addEventListener('click', () => MappaProva.centra());

    Scaricatore.iscriviti(() => this.disegnaDownload(false));
  },

  mostra() {
    this.aggiornaArchivio();
    this.disegnaZona();
    // La mappa va creata quando la schermata è visibile (serve la dimensione)
    requestAnimationFrame(() => MappaProva.mostra());
  },

  async premiScarica() {
    if (Scaricatore.inCorso) { Scaricatore.pausa(); return; }
    if (!navigator.onLine) { avviso('Serve la rete: collegati al Wi-Fi'); return; }
    try {
      const s = await Scaricatore.stima(ZONA_PROVA);
      if (s.mancanti === 0) {
        avviso('Zona già completa: nulla da scaricare');
        return;
      }
      $('z-stima-testo').innerHTML =
        'Da scaricare: <b>' + num(s.mancanti) + '</b> tile su ' + num(s.totale) +
        ', circa <b>' + s.mbStimati.toLocaleString('it-IT', { maximumFractionDigits: 0 }) +
        ' MB</b>. Usa il Wi-Fi. Procedo?';
      $('z-stima').hidden = false;
    } catch (e) {
      avviso('Errore archivio: ' + e.message, 0);
    }
  },

  async premiElimina() {
    if (Scaricatore.inCorso) { avviso('Metti prima in pausa il download'); return; }
    const ora = Date.now();
    if (ora - this.confermaElimina > 4000) {
      this.confermaElimina = ora;
      $('btn-z-elimina').textContent = 'Tocca ancora per eliminare';
      setTimeout(() => {
        if (Date.now() - this.confermaElimina >= 4000) $('btn-z-elimina').textContent = 'Elimina';
      }, 4100);
      return;
    }
    this.confermaElimina = 0;
    $('btn-z-elimina').textContent = 'Elimina';
    try {
      await Archivio.eliminaZona(ZONA_PROVA.id);
      avviso('Zona di prova eliminata');
    } catch (e) {
      avviso('Errore durante l\'eliminazione: ' + e.message, 0);
    }
    Scaricatore.st = null;
    this.aggiornaArchivio();
    this.disegnaZona();
    MappaProva.ricarica();
  },

  async aggiornaArchivio() {
    const p = await Archivio.persistente();
    const ep = $('a-persist');
    if (p === null) { ep.textContent = 'Non supportata'; ep.className = 'no'; }
    else { ep.textContent = p ? 'Sì' : 'No'; ep.className = p ? 'si' : 'no'; }
    $('btn-persist').hidden = p !== false;

    try { $('a-tile').textContent = num(await Archivio.contaTile()); }
    catch (e) { $('a-tile').textContent = 'errore'; }

    const s = await Archivio.spazio();
    $('a-usato').textContent = s ? peso(s.usage) : 'n.d.';
    $('a-libero').textContent = s ? peso(Math.max(0, s.quota - s.usage)) : 'n.d.';
  },

  // Stato salvato della zona (quando non c'è un download in corso)
  async disegnaZona() {
    if (Scaricatore.inCorso) { this.disegnaDownload(true); return; }
    let z = null;
    try { z = await Archivio.leggiZona(ZONA_PROVA.id); } catch (e) { /* archivio non leggibile */ }
    const totale = elencoTile(ZONA_PROVA).length;
    const salvate = z ? z.salvate : 0;
    $('z-stato').textContent = !z ? 'Assente' : (z.stato === 'completa' ? 'Completa' : 'Parziale');
    $('z-stato').className = z && z.stato === 'completa' ? 'si' : 'no';
    $('z-tile').textContent = num(salvate) + ' / ' + num(totale);
    $('z-mb').textContent = z ? peso(z.byte) : '–';
    $('z-barra').style.width = (100 * salvate / totale).toFixed(1) + '%';
    const msg = Scaricatore.errore || '';
    $('z-msg').textContent = msg;
    $('btn-z-scarica').textContent = !z ? 'Scarica' : (z.stato === 'completa' ? 'Controlla / completa' : 'Riprendi');
    $('btn-z-scarica').classList.remove('ferma');
  },

  // Avanzamento durante il download (ridisegno al massimo 4 volte al secondo)
  disegnaDownload(forza) {
    if (!$('scarica').classList.contains('attiva')) {
      if (!Scaricatore.inCorso) aggiornaSchermoAcceso();
      return;
    }
    if (!Scaricatore.inCorso) {
      aggiornaSchermoAcceso();
      this.aggiornaArchivio();
      this.disegnaZona();
      MappaProva.ricarica();
      if (!Scaricatore.errore && Scaricatore.st) {
        const f = Scaricatore.st.falliti.length;
        avviso(Scaricatore.fermato ? 'Download in pausa' :
          (f ? 'Download finito con ' + f + ' tile non scaricate: premi Riprendi' : 'Zona di prova completa'));
      }
      return;
    }
    const ora = Date.now();
    if (!forza && ora - this.ultimoDisegno < 250) return;
    this.ultimoDisegno = ora;
    aggiornaSchermoAcceso();

    const st = Scaricatore.st;
    $('z-stato').textContent = Scaricatore.fermato ? 'Metto in pausa…' :
      (st.giro > 1 ? 'Ripeto le fallite (' + st.giro + '° giro)…' : 'Scarico…');
    $('z-stato').className = '';
    $('z-tile').textContent = num(st.salvate) + ' / ' + num(st.totale) +
      (st.falliti.length ? '  (' + st.falliti.length + ' fallite)' : '');
    $('z-mb').textContent = peso(st.byte);
    $('z-barra').style.width = (100 * st.salvate / st.totale).toFixed(1) + '%';
    $('z-msg').textContent = Scaricatore.errore || '';
    $('btn-z-scarica').textContent = 'Pausa';
    $('btn-z-scarica').classList.add('ferma');
  }
};

/* =====================================================================
   NAVIGAZIONE TRA SCHERMATE (con tasto Indietro di Android)
   ===================================================================== */
const SCHERMATE = ['home', 'volo', 'scarica', 'impostazioni'];

function mostraSchermata() {
  const nome = location.hash.replace('#', '') || 'home';
  const scelta = SCHERMATE.includes(nome) ? nome : 'home';
  SCHERMATE.forEach((s) => $(s).classList.toggle('attiva', s === scelta));
  if (scelta === 'impostazioni') aggiornaStato();
  if (scelta === 'scarica') UIScarica.mostra();
  aggiornaSchermoAcceso();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', mostraSchermata);

/* =====================================================================
   STATO RETE
   ===================================================================== */
function aggiornaRete() {
  const chip = $('stato-rete');
  const online = navigator.onLine;
  chip.textContent = online ? 'Online' : 'Offline';
  chip.className = 'chip ' + (online ? 'online' : 'offline');
  $('i-rete').textContent = online ? 'Connesso' : 'Nessuna rete';
}
window.addEventListener('online', aggiornaRete);
window.addEventListener('offline', aggiornaRete);

/* =====================================================================
   PANNELLO "STATO DELL'APP" (Impostazioni)
   ===================================================================== */
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

  // Permesso posizione
  const ep = $('i-gps');
  if (navigator.permissions && navigator.permissions.query) {
    try {
      const p = await navigator.permissions.query({ name: 'geolocation' });
      const testi = { granted: 'Concesso', prompt: 'Da chiedere', denied: 'Negato' };
      ep.textContent = testi[p.state] || p.state;
      ep.className = p.state === 'granted' ? 'si' : 'no';
    } catch (e) { ep.textContent = 'n.d.'; ep.className = ''; }
  } else { ep.textContent = 'n.d.'; ep.className = ''; }

  const s = await Archivio.spazio();
  $('i-spazio').textContent = s ? peso(s.usage) : 'n.d.';
}

/* =====================================================================
   AVVISI IN BASSO
   ===================================================================== */
let timerAvviso;
function avviso(testo, durataMs = 4000) {
  $('avviso').textContent = testo;
  clearTimeout(timerAvviso);
  if (durataMs) timerAvviso = setTimeout(() => { $('avviso').textContent = ''; }, durataMs);
}

/* =====================================================================
   SERVICE WORKER
   ===================================================================== */
if ('serviceWorker' in navigator) {
  const avevaController = !!navigator.serviceWorker.controller;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      avviso('Errore: modalità offline non attiva', 0);
    });
  });

  navigator.serviceWorker.addEventListener('message', (ev) => {
    if (ev.data && ev.data.tipo === 'cache-pronta') {
      avviso('App pronta per l\'uso senza rete');
      aggiornaStato();
    }
  });

  // Nuova versione installata: ricarica una volta per usarla (mai durante un download)
  let ricaricata = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!avevaController || ricaricata || Scaricatore.inCorso) return;
    ricaricata = true;
    location.reload();
  });
} else {
  avviso('Questo browser non supporta la modalità offline', 0);
}

/* =====================================================================
   AVVIO
   ===================================================================== */
aggiornaRete();
preparaSchermataVolo();
UIScarica.prepara();
mostraSchermata();
