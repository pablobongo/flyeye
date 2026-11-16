// FlyEye — mappa.js (punto 3: mappa MapLibre che legge solo dal telefono)
// La mappa chiede le tile con indirizzi "flyeye://fonte/z/x/y": il protocollo
// personalizzato le legge dall'archivio IndexedDB, mai dalla rete.
'use strict';

// Tile trasparente 1×1 per le zone non scaricate (si vede lo sfondo scuro)
const PNG_VUOTO = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0)
).buffer;

const Mappa = {
  protocolloPronto: false,
  tileServite: 0,     // tile lette dall'archivio (per le prove)
  tileMancanti: 0,    // tile chieste ma non presenti

  disponibile() {
    return typeof maplibregl !== 'undefined';
  },

  registraProtocollo() {
    if (this.protocolloPronto || !this.disponibile()) return;
    maplibregl.addProtocol('flyeye', async (params) => {
      // params.url = "flyeye://s2-2025/13/4400/3150"
      const chiave = params.url.slice('flyeye://'.length);
      try {
        const v = await Archivio.leggiTile(chiave);
        if (v) { this.tileServite++; return { data: v.dati }; }
      } catch (e) { /* archivio non leggibile: tile vuota */ }
      this.tileMancanti++;
      return { data: PNG_VUOTO.slice(0) };
    });
    this.protocolloPronto = true;
  },

  stile(fonteId) {
    const f = FONTI[fonteId];
    return {
      version: 8,
      sources: {
        sat: {
          type: 'raster',
          tiles: ['flyeye://' + fonteId + '/{z}/{x}/{y}'],
          tileSize: 256,
          maxzoom: f.zoomMax,
          attribution: f.attribuzione
        }
      },
      layers: [
        { id: 'sfondo', type: 'background', paint: { 'background-color': '#0b0f14' } },
        { id: 'sat', type: 'raster', source: 'sat' }
      ]
    };
  },

  // Crea una mappa satellitare nel contenitore indicato. Restituisce la mappa o null.
  crea(contenitore, opzioni = {}) {
    if (!this.disponibile()) return null;
    this.registraProtocollo();
    const m = new maplibregl.Map(Object.assign({
      container: contenitore,
      style: this.stile(FONTE_SAT),
      minZoom: 4,
      maxZoom: 16,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: { compact: true },
      fadeDuration: 0
    }, opzioni));
    m.touchZoomRotate.disableRotation();
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    m.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    m.on('error', (e) => console.warn('Mappa:', e && e.error ? e.error.message : e));
    // Crediti chiusi all'avvio (si aprono toccando la "i"): non coprono la mappa
    m.on('load', () => {
      m.getContainer().querySelectorAll('.maplibregl-compact-show')
        .forEach((el) => el.classList.remove('maplibregl-compact-show'));
    });
    return m;
  }
};

/* =====================================================================
   MAPPA DI PROVA nella schermata "Scarica tratta"
   ===================================================================== */
const MappaProva = {
  mappa: null,

  limiti(z) {
    return [[z.ovest, z.sud], [z.est, z.nord]];
  },

  mostra() {
    const box = document.getElementById('mappa');
    if (!this.mappa) {
      if (!Mappa.disponibile()) {
        box.textContent = 'Libreria mappa non caricata.';
        return;
      }
      try {
        this.mappa = Mappa.crea(box, {
          bounds: this.limiti(ZONA_PROVA),
          fitBoundsOptions: { padding: 20 }
        });
      } catch (e) {
        box.textContent = 'Impossibile creare la mappa (WebGL non disponibile?): ' + e.message;
        return;
      }
      const z = document.getElementById('mappa-zoom');
      const scrivi = () => { z.textContent = 'Zoom ' + this.mappa.getZoom().toFixed(1); };
      this.mappa.on('zoom', scrivi);
      this.mappa.on('load', scrivi);
    } else {
      this.mappa.resize();
    }
  },

  centra() {
    if (this.mappa) this.mappa.fitBounds(this.limiti(ZONA_PROVA), { padding: 20 });
  },

  // Dopo un download o una cancellazione: ridisegna le tile leggendo di nuovo l'archivio
  ricarica() {
    if (!this.mappa) return;
    const src = this.mappa.getSource('sat');
    if (src && src.setTiles) src.setTiles(['flyeye://' + FONTE_SAT + '/{z}/{x}/{y}']);
  }
};
