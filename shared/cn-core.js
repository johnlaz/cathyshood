/**
 * CATHY'S NEIGHBORHOOD — Shared Core Engine v1.0
 * cn-core.js
 *
 * Exports (all attached to window.CN):
 *   CN.Toybox       — IndexedDB item pipeline (save/load/transfer)
 *   CN.Item         — Universal draggable/tappable/sound-ready object
 *   CN.DragSystem   — Unified pointer/touch drag coordinator
 *   CN.SoundManager — Web Audio pre-loader (silent in v1, ready for v2)
 *   CN.Room         — Room lifecycle helpers (back, greet, haptic)
 *   CN.FX           — Visual effects (stars, ripple, confetti)
 */

'use strict';

window.CN = window.CN || {};

/* ── BASE PATH DETECTION ──────────────────────────────────
   Finds the root of the app regardless of subdirectory depth.
   Works on GitHub Pages and localhost, regardless of repo name.
   All rooms use CN.BASE to build absolute paths.
─────────────────────────────────────────────────────────── */
CN.BASE = (function() {
  // Primary: read our own <script src> to locate the app root.
  // Works in any repo name, any subdirectory, localhost or GitHub Pages.
  // e.g. src="https://user.github.io/my-repo/shared/cn-core.js"
  //   -> CN.BASE = "https://user.github.io/my-repo"
  const me = document.currentScript ||
    Array.from(document.querySelectorAll('script[src]'))
         .find(s => s.src.includes('/shared/cn-core.js'));
  if (me && me.src) {
    return me.src.replace(/\/shared\/cn-core\.js.*$/, '');
  }
  // Fallback: walk up pathname until we find a segment before 'rooms/'
  const parts = location.pathname.replace(/\/$/, '').split('/');
  const ri = parts.lastIndexOf('rooms');
  if (ri > 0) return location.origin + parts.slice(0, ri).join('/');
  // Last resort: assume we are at the root
  return location.origin + parts.slice(0, -1).join('/');
})();

/* ═══════════════════════════════════════════════════════════
   CONSTANTS
═══════════════════════════════════════════════════════════ */
CN.DB_NAME    = 'CathysNeighborhood';
CN.DB_VERSION = 1;
CN.STORE_TOYBOX  = 'toybox';
CN.STORE_ROOMS   = 'roomState';
CN.STORE_GALLERY = 'gallery';

/* ═══════════════════════════════════════════════════════════
   TOYBOX — IndexedDB item pipeline
   Items travel between rooms. A cookie baked in Kitchen
   can be dragged to feed the dog in the Backyard.

   Item shape:
   {
     id:       string  (unique, e.g. 'cookie_1234')
     type:     string  (e.g. 'cookie', 'cake', 'painting')
     emoji:    string
     name:     string
     origin:   string  (room id where it was created)
     data:     object  (room-specific payload, e.g. {color:'#ff0'})
     slot:     number  (0-4, toybox slot index)
     created:  number  (Date.now())
   }
═══════════════════════════════════════════════════════════ */
CN.Toybox = (() => {
  let _db = null;

  async function open() {
    if (_db) return _db;
    return new Promise((res, rej) => {
      const req = indexedDB.open(CN.DB_NAME, CN.DB_VERSION);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(CN.STORE_TOYBOX)) {
          const s = db.createObjectStore(CN.STORE_TOYBOX, { keyPath: 'id' });
          s.createIndex('slot',   'slot',   { unique: false });
          s.createIndex('type',   'type',   { unique: false });
          s.createIndex('origin', 'origin', { unique: false });
        }
        if (!db.objectStoreNames.contains(CN.STORE_ROOMS)) {
          db.createObjectStore(CN.STORE_ROOMS, { keyPath: 'roomId' });
        }
        if (!db.objectStoreNames.contains(CN.STORE_GALLERY)) {
          const g = db.createObjectStore(CN.STORE_GALLERY, { keyPath: 'id' });
          g.createIndex('roomId', 'roomId', { unique: false });
        }
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function _tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(store, mode);
      const s  = tx.objectStore(store);
      const req = fn(s);
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
  }

  /** Get all items currently in the toybox (slots 0-4) */
  async function getAll() {
    const db = await open();
    return new Promise((res, rej) => {
      const tx  = db.transaction(CN.STORE_TOYBOX, 'readonly');
      const req = tx.objectStore(CN.STORE_TOYBOX).getAll();
      req.onsuccess = e => res(e.target.result || []);
      req.onerror   = e => rej(e.target.error);
    });
  }

  /** Get items filtered by type */
  async function getByType(type) {
    const all = await getAll();
    return all.filter(i => i.type === type);
  }

  /** Add a new item to the first empty slot. Returns slot index or -1 if full. */
  async function add(item) {
    const all   = await getAll();
    const used  = new Set(all.map(i => i.slot));
    const slot  = [0,1,2,3,4].find(n => !used.has(n));
    if (slot === undefined) return -1;           // toybox full
    const entry = {
      id:      item.id || (item.type + '_' + Date.now()),
      type:    item.type,
      emoji:   item.emoji   || '📦',
      name:    item.name    || item.type,
      origin:  item.origin  || 'unknown',
      data:    item.data    || {},
      slot,
      created: Date.now(),
    };
    await _tx(CN.STORE_TOYBOX, 'readwrite', s => s.put(entry));
    return slot;
  }

  /** Remove item by id */
  async function remove(id) {
    return _tx(CN.STORE_TOYBOX, 'readwrite', s => s.delete(id));
  }

  /** Remove all items of a given type */
  async function removeByType(type) {
    const items = await getByType(type);
    const db    = await open();
    return new Promise((res, rej) => {
      const tx = db.transaction(CN.STORE_TOYBOX, 'readwrite');
      const s  = tx.objectStore(CN.STORE_TOYBOX);
      items.forEach(i => s.delete(i.id));
      tx.oncomplete = res;
      tx.onerror    = e => rej(e.target.error);
    });
  }

  /** Clear entire toybox */
  async function clear() {
    return _tx(CN.STORE_TOYBOX, 'readwrite', s => s.clear());
  }

  return { open, getAll, getByType, add, remove, removeByType, clear };
})();

/* ═══════════════════════════════════════════════════════════
   ROOM STATE — persist per-room progress
═══════════════════════════════════════════════════════════ */
CN.RoomState = (() => {
  async function save(roomId, data) {
    const db = await CN.Toybox.open();
    return new Promise((res, rej) => {
      const tx  = db.transaction(CN.STORE_ROOMS, 'readwrite');
      const req = tx.objectStore(CN.STORE_ROOMS).put({ roomId, data, saved: Date.now() });
      req.onsuccess = res;
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function load(roomId) {
    const db = await CN.Toybox.open();
    return new Promise((res, rej) => {
      const tx  = db.transaction(CN.STORE_ROOMS, 'readonly');
      const req = tx.objectStore(CN.STORE_ROOMS).get(roomId);
      req.onsuccess = e => res(e.target.result ? e.target.result.data : null);
      req.onerror   = e => rej(e.target.error);
    });
  }

  return { save, load };
})();

/* ═══════════════════════════════════════════════════════════
   GALLERY — save paintings/snapshots
═══════════════════════════════════════════════════════════ */
CN.Gallery = (() => {
  async function save(roomId, dataUrl, meta = {}) {
    const db = await CN.Toybox.open();
    const entry = {
      id:      'img_' + Date.now(),
      roomId,
      dataUrl,
      meta,
      created: Date.now(),
    };
    return new Promise((res, rej) => {
      const tx  = db.transaction(CN.STORE_GALLERY, 'readwrite');
      const req = tx.objectStore(CN.STORE_GALLERY).put(entry);
      req.onsuccess = () => res(entry.id);
      req.onerror   = e => rej(e.target.error);
    });
  }

  async function getAll(roomId) {
    const db = await CN.Toybox.open();
    return new Promise((res, rej) => {
      const tx    = db.transaction(CN.STORE_GALLERY, 'readonly');
      const store = tx.objectStore(CN.STORE_GALLERY);
      const idx   = store.index('roomId');
      const req   = roomId ? idx.getAll(roomId) : store.getAll();
      req.onsuccess = e => res(e.target.result || []);
      req.onerror   = e => rej(e.target.error);
    });
  }

  return { save, getAll };
})();

/* ═══════════════════════════════════════════════════════════
   ITEM CLASS
   Every interactive object in every room uses this class.
   Gives it: drag, tap, sound hook, toybox add, visual state.

   Usage:
     const cookie = new CN.Item({
       type:   'cookie',
       emoji:  '🍪',
       name:   'Chocolate Cookie',
       origin: 'kitchen',
       el:     document.getElementById('cookie'),
       onTap:  () => { ... },
       onDrop: (dropTarget) => { ... },
     });
     cookie.enableDrag();
═══════════════════════════════════════════════════════════ */
CN.Item = class {
  constructor(opts = {}) {
    this.type    = opts.type    || 'item';
    this.emoji   = opts.emoji   || '📦';
    this.name    = opts.name    || 'Item';
    this.origin  = opts.origin  || 'unknown';
    this.data    = opts.data    || {};
    this.el      = opts.el      || null;
    this.onTap   = opts.onTap   || null;
    this.onDrop  = opts.onDrop  || null;
    this.onPickup= opts.onPickup|| null;
    this.dragging= false;
    this._ox = 0; this._oy = 0;  // drag offset
    this._startX = 0; this._startY = 0;
    this._clone  = null;
  }

  /** Make the element draggable. Clone floats under finger; original stays in place. */
  enableDrag() {
    if (!this.el) return;
    const self = this;

    const start = e => {
      e.preventDefault();
      const pt = e.touches ? e.touches[0] : e;
      self._startX = pt.clientX; self._startY = pt.clientY;
      self.dragging = false;

      // Create floating clone
      const rect = self.el.getBoundingClientRect();
      self._clone = self.el.cloneNode(true);
      self._clone.style.cssText = `
        position:fixed; z-index:9999; pointer-events:none;
        left:${rect.left}px; top:${rect.top}px;
        width:${rect.width}px; height:${rect.height}px;
        opacity:0.85; transform:scale(1.15);
        transition:transform .15s;
        filter:drop-shadow(0 8px 20px rgba(0,0,0,0.4));
      `;
      document.body.appendChild(self._clone);
      self._ox = pt.clientX - rect.left;
      self._oy = pt.clientY - rect.top;
      self.el.style.opacity = '0.4';
      if (self.onPickup) self.onPickup();
      CN.FX.haptic('pickup');
    };

    const move = e => {
      if (!self._clone) return;
      const pt = e.touches ? e.touches[0] : e;
      const dx = pt.clientX - self._startX;
      const dy = pt.clientY - self._startY;
      if (!self.dragging && Math.sqrt(dx*dx+dy*dy) > 8) self.dragging = true;
      if (!self.dragging) return;
      self._clone.style.left = (pt.clientX - self._ox) + 'px';
      self._clone.style.top  = (pt.clientY - self._oy) + 'px';
    };

    const end = e => {
      if (!self._clone) return;
      const pt = e.changedTouches ? e.changedTouches[0] : e;

      // Find drop target
      self._clone.style.display = 'none';
      const target = document.elementFromPoint(pt.clientX, pt.clientY);
      self._clone.style.display = '';

      if (self.dragging) {
        const dropZone = target ? target.closest('[data-drop]') : null;
        if (dropZone && self.onDrop) {
          // Animate clone flying to drop target
          const tRect = dropZone.getBoundingClientRect();
          self._clone.style.transition = 'all .25s cubic-bezier(.34,1.56,.64,1)';
          self._clone.style.left = (tRect.left + tRect.width/2 - parseInt(self._clone.style.width)/2) + 'px';
          self._clone.style.top  = (tRect.top  + tRect.height/2 - parseInt(self._clone.style.height)/2) + 'px';
          self._clone.style.transform = 'scale(0.5)';
          self._clone.style.opacity   = '0';
          setTimeout(() => {
            self._clone?.remove(); self._clone = null;
            self.el.style.opacity = '1';
            self.onDrop(dropZone);
            CN.FX.haptic('drop');
          }, 260);
        } else {
          // Snap back
          self._clone.style.transition = 'all .2s ease';
          const rect = self.el.getBoundingClientRect();
          self._clone.style.left = rect.left + 'px';
          self._clone.style.top  = rect.top  + 'px';
          self._clone.style.transform = 'scale(1)';
          self._clone.style.opacity   = '0';
          setTimeout(() => { self._clone?.remove(); self._clone = null; self.el.style.opacity='1'; }, 220);
        }
      } else {
        // It was a tap
        self._clone.remove(); self._clone = null;
        self.el.style.opacity = '1';
        if (self.onTap) self.onTap();
      }
      self.dragging = false;
    };

    this.el.addEventListener('mousedown',  start);
    this.el.addEventListener('touchstart', start, { passive: false });
    window.addEventListener('mousemove',  move);
    window.addEventListener('touchmove',  move, { passive: false });
    window.addEventListener('mouseup',    end);
    window.addEventListener('touchend',   end);
  }

  /** Add this item to the toybox. Returns slot index or -1 if full. */
  async addToToybox() {
    return CN.Toybox.add({
      type:   this.type,
      emoji:  this.emoji,
      name:   this.name,
      origin: this.origin,
      data:   this.data,
    });
  }
};

/* ═══════════════════════════════════════════════════════════
   DRAG SYSTEM — coordinate multiple draggables in a room
   Rooms use this instead of hand-rolling event listeners.
═══════════════════════════════════════════════════════════ */
CN.DragSystem = {
  _items: new Map(),

  register(id, item) {
    this._items.set(id, item);
    item.enableDrag();
  },

  unregister(id) {
    this._items.delete(id);
  },

  get(id) {
    return this._items.get(id);
  },

  clear() {
    this._items.clear();
  },
};

/* ═══════════════════════════════════════════════════════════
   SOUND MANAGER
   Silent in v1. In v2, replace AUDIO_FILES paths with real MP3s.
   All rooms call CN.Sound.play('great-job') — the plumbing is ready.
═══════════════════════════════════════════════════════════ */
CN.Sound = (() => {
  const AUDIO_FILES = {
    // Action feedback
    'great-job':    'audio/action_great-job.mp3',
    'try-again':    'audio/action_try-again.mp3',
    'wow':          'audio/action_wow.mp3',
    'good-morning': 'audio/greet_morning.mp3',
    // Room names
    'room-kitchen': 'audio/room_kitchen.mp3',
    'room-salon':   'audio/room_salon.mp3',
    'room-garage':  'audio/room_garage.mp3',
    'room-pond':    'audio/room_pond.mp3',
    'room-music':   'audio/room_music.mp3',
    // Safety
    'hot-careful':  'audio/safety_hot.mp3',
    'wear-goggles': 'audio/safety_goggles.mp3',
    // UI
    'pickup':       'audio/ui_pickup.mp3',
    'drop':         'audio/ui_drop.mp3',
    'success':      'audio/ui_success.mp3',
    'tap':          'audio/ui_tap.mp3',
  };

  const _ctx    = null;
  const _buffers = {};
  let   _ready  = false;
  let   _muted  = false;

  /** Call once on first user gesture to unlock audio context */
  function unlock() {
    if (_ready) return;
    // AudioContext created here — will be wired in v2
    _ready = true;
  }

  /** Preload all audio files (call on room load) */
  async function preload(keys = Object.keys(AUDIO_FILES)) {
    // No-op in v1 (silent). In v2: fetch + decodeAudioData each file.
    return Promise.resolve();
  }

  /** Play a sound by key. Silent in v1, real audio in v2. */
  function play(key, opts = {}) {
    if (_muted || !_ready) return;
    // v2: _ctx.createBufferSource() → connect → start
  }

  function mute(val)   { _muted = val; }
  function isMuted()   { return _muted; }

  return { unlock, preload, play, mute, isMuted };
})();

/* ═══════════════════════════════════════════════════════════
   ROOM HELPERS — lifecycle utilities for every room
═══════════════════════════════════════════════════════════ */
CN.Room = {
  /** Go back one screen (browser history). Falls back to map if no history. */
  goBack() {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.location.href = CN.BASE + '/index.html';
    }
  },

  /** Always navigate to the neighborhood map */
  goHome() {
    window.location.href = CN.BASE + '/index.html';
  },

  /** Show a floating greeting bubble (expects #greeting el in room shell) */
  greet(msg, duration = 3000) {
    const g = document.getElementById('greeting');
    if (!g) return;
    clearTimeout(CN.Room._greetTimer);
    g.textContent = msg;
    g.classList.add('show');
    CN.Room._greetTimer = setTimeout(() => g.classList.remove('show'), duration);
  },

  /** Haptic — wraps navigator.vibrate with pattern presets */
  haptic(type = 'tap') {
    if (!navigator.vibrate) return;
    const patterns = {
      tap:      [10],
      pickup:   [15, 8, 15],
      drop:     [20, 10, 40],
      success:  [20, 10, 20, 10, 60],
      drill:    [30, 20, 30, 20, 30, 20, 80],
      error:    [50, 20, 50],
    };
    navigator.vibrate(patterns[type] || patterns.tap);
  },

  /** Standard room init: load state, render toybox, unlock audio */
  async init(roomId, onStateLoaded) {
    CN.Sound.unlock();
    const state = await CN.RoomState.load(roomId);
    if (onStateLoaded) await onStateLoaded(state);
    await renderToyboxBar();
    return state;
  },

  /** Save room state and show feedback */
  async save(roomId, data) {
    await CN.RoomState.save(roomId, data);
  },
};

/* ═══════════════════════════════════════════════════════════
   TOYBOX BAR RENDERER
   Reads IndexedDB and updates the 5-slot bar in any room.
   Rooms include <div id="toybox-bar"></div> in their HTML.
═══════════════════════════════════════════════════════════ */
async function renderToyboxBar() {
  const bar = document.getElementById('toybox-bar');
  if (!bar) return;

  const items = await CN.Toybox.getAll();
  const slots = Array(5).fill(null);
  items.forEach(item => { if (item.slot >= 0 && item.slot < 5) slots[item.slot] = item; });

  bar.innerHTML = slots.map((item, i) => `
    <div class="tb-slot ${item ? 'filled' : ''}"
         data-slot="${i}"
         onclick="CN._slotTap(${i})"
         title="${item ? item.name : 'Empty slot ' + (i+1)}">
      ${item ? `<span class="tb-emoji">${item.emoji}</span>` : ''}
      <span class="tb-num">${i+1}</span>
    </div>
  `).join('');
}

CN._slotTap = async function(idx) {
  const items = await CN.Toybox.getAll();
  const item  = items.find(i => i.slot === idx);
  if (item) {
    CN.Room.greet(`${item.emoji} ${item.name} from ${item.origin}! 🎒`);
    CN.FX.haptic('tap');
  } else {
    CN.Room.greet('Empty slot! Collect items by playing! 🎁');
  }
};

/* ═══════════════════════════════════════════════════════════
   FX — Visual effects usable in every room
═══════════════════════════════════════════════════════════ */
CN.FX = {
  haptic: CN.Room.haptic,  // alias

  /** Burst of emoji stars from a point */
  stars(x, y, n = 6, emojis = ['⭐','🌟','✨','💫','🌸','🎉']) {
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      el.style.cssText = `
        position:fixed; left:${x}px; top:${y}px; z-index:9998;
        font-size:${1.2 + Math.random() * .8}rem; pointer-events:none;
        animation: cnStarFly ${(.4 + Math.random() * .5).toFixed(2)}s ease-out forwards;
        animation-delay:${(Math.random() * .12).toFixed(2)}s;
        --tx:${(Math.cos(Math.random()*Math.PI*2) * (50+Math.random()*60)).toFixed(0)}px;
        --ty:${(-30 - Math.random()*60).toFixed(0)}px;
      `;
      el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 900);
    }
  },

  /** Ripple effect centered on an element */
  ripple(el) {
    const rip = document.createElement('div');
    rip.style.cssText = `
      position:absolute; inset:0; border-radius:inherit;
      background:rgba(255,255,255,.45); pointer-events:none;
      animation:cnRipple .55s ease-out forwards;
    `;
    el.style.position = el.style.position || 'relative';
    el.appendChild(rip);
    setTimeout(() => rip.remove(), 600);
  },

  /** Confetti burst (success celebration) */
  confetti(n = 30) {
    const colors = ['#ff6eb4','#ffd700','#00e5cc','#c084fc','#ff7043','#4caf50'];
    for (let i = 0; i < n; i++) {
      const el = document.createElement('div');
      const sz = 6 + Math.random() * 8;
      el.style.cssText = `
        position:fixed;
        left:${20 + Math.random()*60}vw;
        top:-10px; z-index:9997;
        width:${sz}px; height:${sz}px;
        background:${colors[Math.floor(Math.random()*colors.length)]};
        border-radius:${Math.random() > .5 ? '50%' : '2px'};
        pointer-events:none;
        animation:cnConfetti ${(1.2+Math.random()*1.2).toFixed(2)}s ease-in forwards;
        animation-delay:${(Math.random()*.4).toFixed(2)}s;
        --rx:${(Math.random()*360).toFixed(0)}deg;
        --tx:${(Math.random()*80-40).toFixed(0)}px;
      `;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 2800);
    }
  },

  /** Inject the required keyframes into the document once */
  injectKeyframes() {
    if (document.getElementById('cn-fx-styles')) return;
    const s = document.createElement('style');
    s.id = 'cn-fx-styles';
    s.textContent = `
      @keyframes cnStarFly {
        0%   { transform:translate(0,0) scale(1);   opacity:1; }
        100% { transform:translate(var(--tx),var(--ty)) scale(.2); opacity:0; }
      }
      @keyframes cnRipple {
        from { transform:scale(0); opacity:1; }
        to   { transform:scale(2.5); opacity:0; }
      }
      @keyframes cnConfetti {
        0%   { transform:translate(0,0) rotate(0deg);    opacity:1; }
        100% { transform:translate(var(--tx),90vh) rotate(var(--rx)); opacity:0; }
      }
    `;
    document.head.appendChild(s);
  },
};

// Auto-inject FX keyframes on load
CN.FX.injectKeyframes();

/* ═══════════════════════════════════════════════════════════
   RESET — called by parent gate
═══════════════════════════════════════════════════════════ */
CN.reset = async function() {
  await CN.Toybox.clear();
  const db = await CN.Toybox.open();
  return new Promise((res) => {
    const tx = db.transaction([CN.STORE_ROOMS, CN.STORE_GALLERY], 'readwrite');
    tx.objectStore(CN.STORE_ROOMS).clear();
    tx.objectStore(CN.STORE_GALLERY).clear();
    tx.oncomplete = res;
  });
};

console.log('[CN Core] Engine v1.0 loaded ✅');
