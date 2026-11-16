// FlyEye — archivio.js (punto 3: archivio offline delle mappe)
// Contiene: fonti delle immagini, calcolo delle tile, archivio IndexedDB,
// scaricamento delle tile (usato a casa, in Wi-Fi).
'use strict';

/* =====================================================================
   FONTI DELLE IMMAGINI
   Verifica fatta il 16/11/2026: EOX Sentinel-2 cloudless, uso non
   commerciale libero con attribuzione (CC BY-NC-SA 4.0).
   ===================================================================== */
const FONTI = {
  's2-2025': {
    nome: 'Sentinel-2 cloudless 2025 (EOX)',
    url: (z, x, y) =>
      'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/' +
      z + '/' + y + '/' + x + '.jpg',
    zoomMax: 13,       // oltre, la mappa ingrandisce le tile del livello 13
    kbMedi: 25,        // peso medio stimato di una tile, per la stima prima del download
    paralleli: 2,      // richieste contemporanee (basso, per rispetto del server)
    pausaMs: 150,      // pausa dopo ogni tile, per ogni richiesta parallela
    attribuzione:
      '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> ' +
      'by <a href="https://eox.at" target="_blank" rel="noopener">EOX IT Services GmbH</a> ' +
      '(Contains modified Copernicus Sentinel data 2025)'
  }
};
const FONTE_SAT = 's2-2025';

/* =====================================================================
   ZONA DI PROVA (punto 3). Le tratte vere arrivano al punto 4.
   ===================================================================== */
const ZONA_PROVA = {
  id: 'prova-sicilia-est',
  nome: 'Sicilia orientale (prova)',
  fonte: FONTE_SAT,
  sud: 36.90, ovest: 14.60, nord: 38.35, est: 15.75,
  zoomMin: 5,
  zoomMax: 13
};

/* =====================================================================
   CALCOLO DELLE TILE (schema standard web: z/x/y)
   ===================================================================== */
function tileDa(lat, lon, z) {
  const n = 2 ** z;
  const r = lat * Math.PI / 180;
  let x = Math.floor((lon + 180) / 360 * n);
  let y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  x = Math.min(n - 1, Math.max(0, x));
  y = Math.min(n - 1, Math.max(0, y));
  return { x, y };
}

// Elenco di tutte le tile {z, x, y} di una zona rettangolare
function elencoTile(zona) {
  const out = [];
  for (let z = zona.zoomMin; z <= zona.zoomMax; z++) {
    const a = tileDa(zona.nord, zona.ovest, z);
    const b = tileDa(zona.sud, zona.est, z);
    for (let x = a.x; x <= b.x; x++) {
      for (let y = a.y; y <= b.y; y++) out.push({ z, x, y });
    }
  }
  return out;
}

const chiaveTile = (fonte, z, x, y) => fonte + '/' + z + '/' + x + '/' + y;

/* =====================================================================
   ARCHIVIO (IndexedDB "flyeye-dati")
   - store "tile": chiave "fonte/z/x/y" → { dati (ArrayBuffer), byte, zone: [id] }
     Una tile può appartenere a più zone (le tratte si sovrappongono):
     si cancella davvero solo quando nessuna zona la usa più.
   - store "zone": { id, nome, fonte, totale, salvate, byte, stato, aggiornata }
   ===================================================================== */
const DB_NOME = 'flyeye-dati';
const DB_VERSIONE = 1;

const richiesta = (r) => new Promise((ok, ko) => {
  r.onsuccess = () => ok(r.result);
  r.onerror = () => ko(r.error);
});

const Archivio = {
  _db: null,

  apri() {
    if (this._db) return this._db;
    this._db = new Promise((ok, ko) => {
      if (!('indexedDB' in window)) { ko(new Error('IndexedDB non disponibile')); return; }
      const r = indexedDB.open(DB_NOME, DB_VERSIONE);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('tile')) db.createObjectStore('tile');
        if (!db.objectStoreNames.contains('zone')) db.createObjectStore('zone', { keyPath: 'id' });
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ko(r.error);
      r.onblocked = () => ko(new Error('Archivio bloccato: chiudi le altre finestre di FlyEye'));
    });
    this._db.catch(() => { this._db = null; });
    return this._db;
  },

  async store(nome, modo = 'readonly') {
    const db = await this.apri();
    return db.transaction(nome, modo).objectStore(nome);
  },

  async leggiTile(chiave) {
    return richiesta((await this.store('tile')).get(chiave));
  },

  // Se la tile c'è già: la assegna anche a questa zona e restituisce i byte; altrimenti 0
  async segnaPresente(chiave, zonaId) {
    const st = await this.store('tile', 'readwrite');
    const v = await richiesta(st.get(chiave));
    if (!v) return 0;
    if (!v.zone.includes(zonaId)) {
      v.zone.push(zonaId);
      await richiesta(st.put(v, chiave));
    }
    return v.byte;
  },

  async salvaTile(chiave, dati, zonaId) {
    const st = await this.store('tile', 'readwrite');
    await richiesta(st.put({ dati, byte: dati.byteLength, zone: [zonaId] }, chiave));
  },

  async chiaviPresenti(fonte) {
    const st = await this.store('tile');
    const intervallo = IDBKeyRange.bound(fonte + '/', fonte + '/￿');
    return new Set(await richiesta(st.getAllKeys(intervallo)));
  },

  async contaTile() {
    return richiesta((await this.store('tile')).count());
  },

  async leggiZona(id) {
    return richiesta((await this.store('zone')).get(id));
  },

  async salvaZona(zona) {
    return richiesta((await this.store('zone', 'readwrite')).put(zona));
  },

  async elencoZone() {
    return richiesta((await this.store('zone')).getAll());
  },

  // Toglie la zona; cancella le tile che non servono a nessun'altra zona
  async eliminaZona(id) {
    const db = await this.apri();
    await new Promise((ok, ko) => {
      const tx = db.transaction(['tile', 'zone'], 'readwrite');
      const st = tx.objectStore('tile');
      const cur = st.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return;
        const v = c.value;
        if (v.zone.includes(id)) {
          if (v.zone.length === 1) c.delete();
          else { v.zone = v.zone.filter((z) => z !== id); c.update(v); }
        }
        c.continue();
      };
      tx.objectStore('zone').delete(id);
      tx.oncomplete = () => ok();
      tx.onerror = () => ko(tx.error);
      tx.onabort = () => ko(tx.error);
    });
  },

  // Archiviazione persistente: Android non cancella i dati quando manca spazio
  async persistente() {
    if (!navigator.storage || !navigator.storage.persisted) return null;
    try { return await navigator.storage.persisted(); } catch (e) { return null; }
  },

  async chiediPersistenza() {
    if (!navigator.storage || !navigator.storage.persist) return null;
    try { return await navigator.storage.persist(); } catch (e) { return null; }
  },

  async spazio() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try { return await navigator.storage.estimate(); } catch (e) { return null; }
  }
};

/* =====================================================================
   SCARICATORE
   Scarica le tile mancanti di una zona. Salta quelle già presenti,
   ripete due volte quelle fallite, rallenta se il server lo chiede.
   Pausa e ripresa: la ripresa riparte saltando quanto già salvato.
   ===================================================================== */
const attendi = (ms) => new Promise((ok) => setTimeout(ok, ms));

class ErroreFatale extends Error {}

const Scaricatore = {
  inCorso: false,
  fermato: false,
  zona: null,
  st: null,          // { totale, fatti, salvate, byte, falliti: [], giro }
  errore: null,
  erroriDiFila: 0,
  ascoltatori: [],

  iscriviti(fn) { this.ascoltatori.push(fn); },
  avvisa() { this.ascoltatori.forEach((fn) => fn(this)); },

  // Stima prima del download: tile totali, mancanti, MB
  async stima(zona) {
    const lista = elencoTile(zona);
    const presenti = await Archivio.chiaviPresenti(zona.fonte);
    const mancanti = lista.filter((t) => !presenti.has(chiaveTile(zona.fonte, t.z, t.x, t.y))).length;
    const kb = FONTI[zona.fonte].kbMedi;
    return { totale: lista.length, mancanti, mbStimati: mancanti * kb / 1024 };
  },

  pausa() {
    if (this.inCorso) { this.fermato = true; this.avvisa(); }
  },

  async avvia(zona) {
    if (this.inCorso) return;
    const fonte = FONTI[zona.fonte];
    this.inCorso = true;
    this.fermato = false;
    this.errore = null;
    this.erroriDiFila = 0;
    this.zona = zona;
    await Archivio.chiediPersistenza();

    let lista = elencoTile(zona);
    const st = this.st = { totale: lista.length, fatti: 0, salvate: 0, byte: 0, falliti: [], giro: 1 };
    this.avvisa();

    const salvaStato = async (finale) => {
      const completa = st.salvate === st.totale;
      await Archivio.salvaZona({
        id: zona.id, nome: zona.nome, fonte: zona.fonte,
        totale: st.totale, salvate: st.salvate, byte: st.byte,
        stato: completa ? 'completa' : 'parziale',
        aggiornata: Date.now()
      });
      if (finale) this.avvisa();
    };

    const esegui = async (elenco) => {
      let i = 0;
      const prendi = () => (i < elenco.length ? elenco[i++] : null);
      const lavora = async () => {
        let t;
        while (!this.fermato && (t = prendi())) {
          await this.unaTile(zona, fonte, t);
          if (st.fatti % 50 === 0) await salvaStato(false);
        }
      };
      await Promise.all(Array.from({ length: fonte.paralleli }, lavora));
    };

    try {
      await esegui(lista);
      // Ripete le tile fallite, fino a 2 volte
      for (let g = 2; g <= 3 && !this.fermato && st.falliti.length; g++) {
        lista = st.falliti;
        st.falliti = [];
        st.fatti -= lista.length;
        st.giro = g;
        this.avvisa();
        await attendi(3000);
        await esegui(lista);
      }
    } catch (e) {
      this.errore = e.message;
    }

    this.inCorso = false;
    await salvaStato(true);
  },

  async unaTile(zona, fonte, t) {
    const st = this.st;
    const chiave = chiaveTile(zona.fonte, t.z, t.x, t.y);
    try {
      const giaPresente = await Archivio.segnaPresente(chiave, zona.id);
      if (giaPresente) {
        st.byte += giaPresente;
        st.salvate++;
      } else {
        const dati = await this.scarica(fonte.url(t.z, t.x, t.y));
        await Archivio.salvaTile(chiave, dati, zona.id);
        st.byte += dati.byteLength;
        st.salvate++;
        this.erroriDiFila = 0;
        await attendi(fonte.pausaMs);
      }
    } catch (e) {
      if (e instanceof ErroreFatale) {
        this.errore = e.message;
        this.fermato = true;
      } else if (e && e.name === 'QuotaExceededError') {
        this.errore = 'Spazio sul telefono esaurito.';
        this.fermato = true;
      } else {
        st.falliti.push(t);
        this.erroriDiFila++;
        if (this.erroriDiFila >= 10) {
          this.errore = navigator.onLine
            ? 'Il server delle mappe non risponde o rifiuta le richieste (10 errori di fila). Riprova più tardi.'
            : 'Rete assente: collegati al Wi-Fi e premi Riprendi.';
          this.fermato = true;
        }
      }
    }
    st.fatti++;
    this.avvisa();
  },

  // Scarica una tile; se il server chiede di rallentare (429/503) aspetta e riprova
  async scarica(url) {
    for (let tentativo = 1; tentativo <= 3; tentativo++) {
      if (!navigator.onLine) throw new ErroreFatale('Rete assente: collegati al Wi-Fi e premi Riprendi.');
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20000);
      let r;
      try {
        r = await fetch(url, { mode: 'cors', signal: ac.signal, cache: 'no-store' });
      } finally {
        clearTimeout(timer);
      }
      if (r.status === 429 || r.status === 503) {
        await attendi(15000 * tentativo);
        continue;
      }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const tipo = r.headers.get('content-type') || '';
      if (!tipo.startsWith('image/')) throw new Error('Risposta non è un\'immagine');
      const dati = await r.arrayBuffer();
      if (dati.byteLength < 100) throw new Error('Tile vuota o danneggiata');
      return dati;
    }
    throw new Error('Server occupato');
  }
};
