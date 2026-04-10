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

/* ── ITEM CLASSIFICATION ──────────────────────────────────────────────── */
CN.FOOD_TYPES = new Set([
  'cookie','cake','smoothie','salad','veggie_mix',
  'cooked_egg','cooked_meat','cooked_waffle','cooked_shrimp',
  'carrot','tomato','broccoli','flower','berry','corn',
  'apple','fish','peanut','bone','clippings',
]);

CN.isFoodType = (type) => {
  if (!type) return false;
  if (CN.FOOD_TYPES.has(type)) return true;
  if (type.startsWith('cooked_')) return true;
  if (type.endsWith('_token')) return false;
  return false;
};


CN.DB_VERSION = 2;
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
        if (!db.objectStoreNames.contains('coins')) {
          db.createObjectStore('coins', { keyPath: 'id' });
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
    const all  = await getAll();
    // Food goes to basket slots 10-17, toys go to toybox slots 0-7
    const isFood = CN.isFoodType(item.type);
    const slotRange = isFood ? [10,11,12,13,14,15,16,17] : [0,1,2,3,4,5,6,7];
    const used = new Set(all.map(i => i.slot));
    const slot = slotRange.find(n => !used.has(n));
    if (slot === undefined) {
      // Full — auto-convert oldest item of same category to coins
      const oldest = all.filter(i => slotRange.includes(i.slot)).sort((a,b)=>a.created-b.created)[0];
      if(oldest){ await remove(oldest.id); CN.addCoins(5); }
      const allAfter = await getAll();
      const usedAfter = new Set(allAfter.map(i=>i.slot));
      const slot2 = slotRange.find(n => !usedAfter.has(n));
      if(slot2===undefined) return -1;
      return add(item); // retry
    }
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
  const all = await CN.Toybox.getAll();

  // Toy bar (slots 0-7) → element #toybox-bar
  const toyBar = document.getElementById('toybox-bar');
  if (toyBar) {
    const toySlots = Array(8).fill(null);
    all.forEach(item => { if(item.slot>=0 && item.slot<8) toySlots[item.slot]=item; });
    toyBar.innerHTML = toySlots.map((item,i) => `
      <div class="tb-slot ${item?'filled':''}" data-slot="${i}"
           onclick="CN._slotTap(${i})"
           title="${item?item.name:'Toy slot '+(i+1)}">
        ${item?`<span class="tb-emoji">${item.emoji}</span>`:''}
        <span class="tb-num">${i+1}</span>
      </div>`).join('');
  }

  // Basket bar (slots 10-17) → element #basket-bar
  const baskBar = document.getElementById('basket-bar');
  if (baskBar) {
    const foodSlots = Array(8).fill(null);
    all.forEach(item => { if(item.slot>=10 && item.slot<18) foodSlots[item.slot-10]=item; });
    baskBar.innerHTML = foodSlots.map((item,i) => `
      <div class="tb-slot ${item?'filled':''}" data-slot="${i+10}"
           onclick="CN._slotTap(${i+10})"
           title="${item?item.name:'Food slot '+(i+1)}">
        ${item?`<span class="tb-emoji">${item.emoji}</span>`:''}
        <span class="tb-num">${i+1}</span>
      </div>`).join('');
  }

  // Coin display → element #coin-display
  const coinEl = document.getElementById('coin-display');
  if (coinEl) coinEl.textContent = '🪙 ' + CN.Coins.get();
}

CN._slotTap = async function(idx) {
  const items = await CN.Toybox.getAll();
  const item  = items.find(i => i.slot === idx);
  if (item) {
    const isFood = CN.isFoodType(item.type);
    CN.Room.greet(`${item.emoji} ${item.name}! ${isFood?'🧺 Food basket':'🧸 Toybox'} slot ${idx<10?idx+1:idx-9}!`);
    CN.FX.haptic('tap');
  } else {
    const isFood = idx >= 10;
    CN.Room.greet(isFood ? 'Empty basket slot! Cook food to fill it! 🍳' : 'Empty toy slot! Play to collect toys! 🎮');
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

/* ═══════════════════════════════════════════════════════════
   CN.Anim — GSAP-powered animation system
   Falls back gracefully if GSAP hasn't loaded yet.
   All rooms call CN.Anim.* instead of raw GSAP so we have
   one place to tune feel across the whole app.
═══════════════════════════════════════════════════════════ */
CN.Anim = (() => {
  const g = () => window.gsap; // lazy ref — GSAP loads after this file

  /* ── SPRING PRESETS ───────────────────────────────────────
     bouncy  = playful, used for collectibles + celebrations
     snappy  = UI buttons, immediate feedback
     elastic = drag-release, item landing
     smooth  = page/panel transitions
  ────────────────────────────────────────────────────────── */
  const EASE = {
    bouncy:  'back.out(2.2)',
    snappy:  'back.out(1.4)',
    elastic: 'elastic.out(1, 0.4)',
    smooth:  'power3.out',
    pop:     'back.out(3)',
  };

  /** Button press — squish down, spring back */
  function btnPress(el) {
    if (!g()) return;
    gsap.killTweensOf(el);
    gsap.timeline()
      .to(el,  { scale:.88, duration:.08, ease:'power2.in' })
      .to(el,  { scale:1,   duration:.4,  ease:EASE.bouncy });
  }

  /** Collect item — scale pop + float up + fade */
  function collect(el, onComplete) {
    if (!g()) { if(onComplete) onComplete(); return; }
    gsap.killTweensOf(el);
    gsap.timeline({ onComplete })
      .to(el, { scale:1.35, duration:.15, ease:'power2.out' })
      .to(el, { scale:.9,   duration:.1  })
      .to(el, { scale:1.1,  duration:.08 })
      .to(el, { y:-60, scale:.3, opacity:0, duration:.5, ease:EASE.smooth });
  }

  /** Item flies from source point to target element */
  function flyTo(emoji, fromX, fromY, toEl, onComplete) {
    if (!g()) { if(onComplete) onComplete(); return; }
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;left:${fromX}px;top:${fromY}px;font-size:2rem;
      pointer-events:none;z-index:9999;transform-origin:center;`;
    el.textContent = emoji;
    document.body.appendChild(el);
    const tr = toEl.getBoundingClientRect();
    gsap.to(el, {
      x: tr.left + tr.width/2  - fromX,
      y: tr.top  + tr.height/2 - fromY,
      scale: .3, opacity: 0, duration: .55,
      ease: EASE.smooth,
      onComplete: () => { el.remove(); if(onComplete) onComplete(); }
    });
  }

  /** Celebrate card entrance — scale + bounce from below */
  function celebrateIn(el) {
    if (!g()) return;
    gsap.fromTo(el,
      { scale:.5, y:80, opacity:0 },
      { scale:1,  y:0,  opacity:1, duration:.55, ease:EASE.bouncy }
    );
  }

  /** Shake element — wrong answer, wrong tool etc. */
  function shake(el) {
    if (!g()) return;
    gsap.killTweensOf(el);
    gsap.timeline()
      .to(el, { x:-10, duration:.06, ease:'none' })
      .to(el, { x: 10, duration:.06 })
      .to(el, { x: -8, duration:.06 })
      .to(el, { x:  8, duration:.06 })
      .to(el, { x:  0, duration:.08, ease:EASE.snappy });
  }

  /** Pop element — tap feedback without moving */
  function pop(el) {
    if (!g()) return;
    gsap.killTweensOf(el);
    gsap.timeline()
      .to(el, { scale:1.22, duration:.1,  ease:'power2.out' })
      .to(el, { scale:1,    duration:.35, ease:EASE.bouncy });
  }

  /** Bounce element — repeated pulse (idle animation) */
  function bounce(el, repeat=-1) {
    if (!g()) return;
    return gsap.to(el, {
      y:-10, duration:.55, ease:'sine.inOut',
      yoyo:true, repeat
    });
  }

  /** Wobble — character reaction */
  function wobble(el) {
    if (!g()) return;
    gsap.killTweensOf(el);
    gsap.timeline()
      .to(el, { rotation:-12, scale:1.15, duration:.12 })
      .to(el, { rotation: 10, duration:.1 })
      .to(el, { rotation: -8, duration:.1 })
      .to(el, { rotation:  6, duration:.08 })
      .to(el, { rotation:  0, scale:1, duration:.2, ease:EASE.snappy });
  }

  /** Page/room transition OUT — slide + fade left */
  function transOut(el, onComplete) {
    if (!g()) { if(onComplete) onComplete(); return; }
    gsap.to(el, {
      x:-40, opacity:0, duration:.28,
      ease:'power2.in', onComplete
    });
  }

  /** Page/room transition IN — slide from right */
  function transIn(el) {
    if (!g()) return;
    gsap.fromTo(el,
      { x:60, opacity:0 },
      { x:0,  opacity:1, duration:.4, ease:EASE.smooth }
    );
  }

  /** Stagger children in — for grids of items */
  function staggerIn(parent, selector=':scope > *', stagger=.06) {
    if (!g()) return;
    gsap.fromTo(
      parent.querySelectorAll(selector),
      { scale:.7, opacity:0, y:20 },
      { scale:1,  opacity:1, y:0,
        stagger, duration:.4, ease:EASE.bouncy }
    );
  }

  /** Grow element from 0 height (reveal) */
  function growIn(el) {
    if (!g()) return;
    gsap.fromTo(el,
      { scaleY:0, transformOrigin:'bottom center', opacity:0 },
      { scaleY:1, opacity:1, duration:.5, ease:EASE.bouncy }
    );
  }

  /** Number count-up */
  function countUp(el, from, to, duration=.8, suffix='') {
    if (!g()) { el.textContent = to + suffix; return; }
    gsap.to({ val:from }, {
      val:to, duration,
      ease:EASE.smooth,
      onUpdate: function() {
        el.textContent = Math.round(this.targets()[0].val) + suffix;
      }
    });
  }

  /** Tooltip / hint pop-in */
  function hintIn(el) {
    if (!g()) return;
    gsap.fromTo(el,
      { scale:.6, opacity:0, y:-10 },
      { scale:1,  opacity:1, y:0, duration:.35, ease:EASE.pop }
    );
  }

  /** Pulse border glow — for needed/active elements */
  function glowPulse(el, color='rgba(255,215,0,0.6)') {
    if (!g()) return;
    return gsap.to(el, {
      boxShadow: `0 0 0 6px ${color}, 0 0 24px ${color}`,
      duration:.7, yoyo:true, repeat:-1, ease:'sine.inOut'
    });
  }

  /** Confetti burst — enhanced version */
  function confettiBurst(x, y, count=20) {
    if (!g()) { CN.FX.confetti(count); return; }
    const colors = ['#ff6eb4','#ffd700','#00e5cc','#c084fc','#ff7043','#4caf50','#fff'];
    for (let i=0; i<count; i++) {
      const el = document.createElement('div');
      const sz = 6 + Math.random()*10;
      el.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:${sz}px;height:${sz}px;
        background:${colors[i%colors.length]};border-radius:${Math.random()>.5?'50%':'2px'};
        pointer-events:none;z-index:9997;`;
      document.body.appendChild(el);
      gsap.to(el, {
        x: (Math.random()-0.5)*200,
        y: -100 - Math.random()*180,
        rotation: Math.random()*520-260,
        opacity:0, duration: 1+Math.random()*.8,
        ease:'power2.out',
        delay: Math.random()*.15,
        onComplete: ()=>el.remove()
      });
    }
  }

  /** Stars burst from a point */
  function starBurst(x, y, emojis=['⭐','🌟','✨','💫','🎉']) {
    if (!g()) { CN.FX.stars(x,y,6); return; }
    for (let i=0; i<emojis.length+2; i++) {
      const el = document.createElement('div');
      el.style.cssText = `position:fixed;left:${x}px;top:${y}px;font-size:${1.2+Math.random()*.8}rem;
        pointer-events:none;z-index:9998;`;
      el.textContent = emojis[i % emojis.length];
      document.body.appendChild(el);
      const angle = (i / emojis.length) * Math.PI * 2;
      const dist  = 50 + Math.random()*70;
      gsap.to(el, {
        x: Math.cos(angle)*dist,
        y: Math.sin(angle)*dist - 30,
        scale:.2, opacity:0,
        duration: .6+Math.random()*.4,
        ease:'power2.out',
        delay: Math.random()*.12,
        onComplete: ()=>el.remove()
      });
    }
  }

  /** Close celebrate overlay with animation */
  function celebrateOut(card, overlay) {
    if (!g()) { overlay.classList.remove('show'); return; }
    gsap.to(card, {
      scale:.5, y:60, opacity:0, duration:.3, ease:'power2.in',
      onComplete: () => overlay.classList.remove('show')
    });
  }

  return {
    btnPress, collect, flyTo, celebrateIn, celebrateOut, shake, pop,
    bounce, wobble, transOut, transIn, staggerIn,
    growIn, countUp, hintIn, glowPulse, confettiBurst, starBurst,
    EASE
  };
})();

console.log('[CN Anim] GSAP animation layer ready ✅');

/* ═══════════════════════════════════════════════════════════
   CN.Audio — Synthesized sound effects + background music
   All sounds generated via Web Audio API — no MP3 files needed.
   Background music uses oscillators + filters for each room theme.

   Usage:
     CN.Audio.play('success')        — one-shot SFX
     CN.Audio.play('tap')            — UI feedback
     CN.Audio.bgStart('kitchen')     — start room ambient loop
     CN.Audio.bgStop()               — stop background
     CN.Audio.toggle()               — mute/unmute all audio
     CN.Audio.unlockOnGesture()      — call once on first user tap
═══════════════════════════════════════════════════════════ */
CN.Audio = (() => {
  let ctx = null;
  let muted = false;
  let bgNodes = [];
  let unlocked = false;
  let masterGain = null;

  function getCtx() {
    if (!ctx) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = ctx.createGain();
        masterGain.gain.value = muted ? 0 : 0.7;
        masterGain.connect(ctx.destination);
      } catch(e) { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function unlockOnGesture() {
    if (unlocked) return;
    const unlock = () => {
      if (!unlocked) { getCtx(); unlocked = true; }
    };
    document.addEventListener('pointerdown', unlock, { once: true });
    document.addEventListener('touchstart',  unlock, { once: true, passive: true });
  }

  /* ── NOISE BUFFER (reuse) ── */
  let _noiseBuf = null;
  function getNoise() {
    const c = getCtx(); if (!c) return null;
    if (!_noiseBuf) {
      _noiseBuf = c.createBuffer(1, c.sampleRate * 0.5, c.sampleRate);
      const d = _noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return _noiseBuf;
  }

  /* ── HELPERS ── */
  function osc(freq, type='sine', gain=0.3, dur=0.2, delay=0) {
    const c = getCtx(); if (!c || muted) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type; o.frequency.value = freq;
    o.connect(g); g.connect(masterGain);
    const t = c.currentTime + delay;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.start(t); o.stop(t + dur);
  }

  function noise(filterFreq=2000, filterType='bandpass', gain=0.3, dur=0.1, delay=0) {
    const c = getCtx(); if (!c || muted) return;
    const buf = getNoise(); if (!buf) return;
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = filterType; f.frequency.value = filterFreq;
    const g = c.createGain();
    src.connect(f); f.connect(g); g.connect(masterGain);
    const t = c.currentTime + delay;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.start(t); src.stop(t + dur + 0.05);
  }

  /* ── SOUND EFFECTS LIBRARY ── */
  const SFX = {

    tap() {
      osc(600, 'sine', 0.12, 0.06);
    },

    success() {
      [523, 659, 784, 1047].forEach((f, i) => osc(f, 'sine', 0.2, 0.18, i * 0.08));
    },

    celebrate() {
      [523,659,784,1047,1319].forEach((f,i) => osc(f,'triangle',0.25,0.3,i*.07));
      noise(4000,'highpass',0.1,0.4);
    },

    error() {
      osc(200,'sawtooth',0.2,0.15);
      osc(160,'sawtooth',0.15,0.15,0.08);
    },

    collect() {
      osc(880,'sine',0.2,0.1);
      osc(1100,'sine',0.15,0.1,0.06);
      osc(1320,'sine',0.12,0.12,0.1);
    },

    pop() {
      osc(400,'sine',0.15,0.08);
      osc(600,'sine',0.1,0.05,0.04);
    },

    // Kitchen sounds
    sizzle() {
      noise(3000,'bandpass',0.18,0.8);
      noise(4000,'bandpass',0.1,0.6,0.1);
    },

    chop() {
      noise(800,'lowpass',0.3,0.06);
      osc(180,'square',0.15,0.04,0.02);
    },

    blender() {
      const c = getCtx(); if (!c || muted) return;
      const o = c.createOscillator();
      const g = c.createGain();
      const f = c.createBiquadFilter();
      f.type='bandpass'; f.frequency.value=800; f.Q.value=0.5;
      o.type='sawtooth'; o.frequency.value=120;
      o.frequency.linearRampToValueAtTime(200, c.currentTime+0.3);
      o.connect(f); f.connect(g); g.connect(masterGain);
      g.gain.setValueAtTime(0.25,c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+2.5);
      o.start(); o.stop(c.currentTime+2.5);
    },

    ovenDing() {
      [880,1108].forEach((f,i)=>{
        osc(f,'sine',0.3,0.5,i*0.02);
        osc(f,'sine',0.15,0.4,i*0.02+0.5);
      });
    },

    bubbles() {
      [400,500,600,450,550].forEach((f,i)=>osc(f,'sine',0.08,0.12,i*0.12));
    },

    // Pond sounds
    splash() {
      noise(2000,'lowpass',0.25,0.35);
      osc(200,'sine',0.1,0.2);
    },

    ripple() {
      osc(800,'sine',0.08,0.3);
      osc(1000,'sine',0.05,0.25,0.1);
    },

    // Garage sounds
    drill() {
      const c=getCtx(); if(!c||muted) return;
      const o=c.createOscillator();
      const g=c.createGain();
      o.type='sawtooth'; o.frequency.value=80;
      o.frequency.setValueAtTime(80,c.currentTime);
      o.frequency.linearRampToValueAtTime(120,c.currentTime+0.15);
      o.frequency.linearRampToValueAtTime(80,c.currentTime+0.3);
      o.connect(g); g.connect(masterGain);
      g.gain.setValueAtTime(0.3,c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+0.5);
      o.start(); o.stop(c.currentTime+0.5);
    },

    hammer() {
      noise(600,'lowpass',0.4,0.08);
      osc(250,'square',0.2,0.06);
    },

    wrench() {
      osc(440,'triangle',0.15,0.12);
      osc(380,'triangle',0.1,0.1,0.05);
    },

    robotPowerUp() {
      [200,300,450,600,800].forEach((f,i)=>osc(f,'square',0.15,0.2,i*0.1));
      osc(1200,'sine',0.2,0.4,0.5);
    },

    // Print sounds
    printing() {
      const c=getCtx(); if(!c||muted) return;
      const o=c.createOscillator();
      const g=c.createGain();
      o.type='square'; o.frequency.value=60;
      o.connect(g); g.connect(masterGain);
      g.gain.setValueAtTime(0.08,c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001,c.currentTime+2);
      o.start(); o.stop(c.currentTime+2);
      noise(500,'bandpass',0.06,2);
    },

    scrape() {
      noise(300,'lowpass',0.25,0.15);
      osc(120,'sawtooth',0.1,0.1);
    },

    // Garden sounds
    plant() {
      osc(500,'sine',0.12,0.15);
      osc(700,'sine',0.08,0.12,0.08);
    },

    water() {
      [600,700,800,650,750].forEach((f,i)=>osc(f,'sine',0.06,0.2,i*0.08));
    },

    harvest() {
      osc(660,'sine',0.18,0.12);
      osc(880,'sine',0.15,0.1,0.07);
      osc(1100,'sine',0.1,0.12,0.13);
    },

    // Mower
    engineStart() {
      const c=getCtx(); if(!c||muted) return;
      const o=c.createOscillator();
      const g=c.createGain();
      o.type='sawtooth';
      o.frequency.setValueAtTime(40,c.currentTime);
      o.frequency.linearRampToValueAtTime(100,c.currentTime+1.2);
      o.connect(g); g.connect(masterGain);
      g.gain.setValueAtTime(0.0,c.currentTime);
      g.gain.linearRampToValueAtTime(0.25,c.currentTime+0.3);
      g.gain.setValueAtTime(0.2,c.currentTime+1.2);
      o.start(); o.stop(c.currentTime+1.5);
    },

    mowing() {
      noise(200,'lowpass',0.08,0.3);
    },

    // Salon
    paintStroke() {
      osc(700,'sine',0.06,0.12);
    },

    sparkle() {
      [1200,1500,1800,2000].forEach((f,i)=>osc(f,'sine',0.08,0.15,i*0.04));
    },

    // Construction
    blockSlam() {
      noise(400,'lowpass',0.35,0.12);
      osc(200,'square',0.2,0.08);
    },

    wordCorrect() {
      [523,659,784,1047].forEach((f,i)=>osc(f,'sine',0.22,0.2,i*0.07));
    },

    wordWrong() {
      osc(200,'sawtooth',0.2,0.15);
      osc(160,'sawtooth',0.15,0.12,0.1);
    },

    // Driveway
    waterSpray() {
      noise(3000,'highpass',0.12,0.3);
    },

    bubblePop() {
      osc(600,'sine',0.1,0.05);
      osc(800,'sine',0.07,0.04,0.03);
    },

    chargeStart() {
      osc(440,'sine',0.15,0.3);
      osc(554,'sine',0.12,0.3,0.05);
    },

    chargeComplete() {
      [440,554,659,880].forEach((f,i)=>osc(f,'sine',0.2,0.35,i*0.08));
    },
  };

  /* ── BACKGROUND MUSIC ENGINE ── */
  // Each room gets a unique ambient loop built from oscillators
  const BG_THEMES = {
    kitchen:  { notes:[261,329,392,329], tempo:500, type:'triangle', gain:0.04, filter:'lowpass', filterFreq:800 },
    pond:     { notes:[220,277,329,277], tempo:800, type:'sine',     gain:0.03, filter:'lowpass', filterFreq:600 },
    salon:    { notes:[330,415,494,415], tempo:600, type:'sine',     gain:0.04, filter:'bandpass',filterFreq:1000 },
    garage:   { notes:[110,138,165,138], tempo:400, type:'sawtooth', gain:0.03, filter:'lowpass', filterFreq:400 },
    driveway: { notes:[196,247,294,247], tempo:550, type:'triangle', gain:0.04, filter:'lowpass', filterFreq:700 },
    music:    { notes:[261,329,392,523], tempo:350, type:'square',   gain:0.03, filter:'bandpass',filterFreq:600 },
    garden:   { notes:[293,370,440,370], tempo:700, type:'sine',     gain:0.04, filter:'lowpass', filterFreq:900 },
    mower:    { notes:[110,110,110,110], tempo:300, type:'sawtooth', gain:0.05, filter:'lowpass', filterFreq:300 },
    construction:{ notes:[349,440,523,440], tempo:450, type:'triangle',gain:0.04,filter:'bandpass',filterFreq:700 },
    map:      { notes:[293,369,440,369], tempo:900, type:'sine',     gain:0.03, filter:'lowpass', filterFreq:700 },
  };

  let bgTimer = null;
  let bgStep  = 0;
  let currentTheme = null;

  function bgStart(roomId) {
    bgStop();
    const theme = BG_THEMES[roomId] || BG_THEMES.map;
    currentTheme = theme;
    bgStep = 0;

    function playStep() {
      const c = getCtx(); if (!c || muted) { bgTimer=setTimeout(playStep,theme.tempo); return; }
      const freq = theme.notes[bgStep % theme.notes.length];
      const o = c.createOscillator();
      const f = c.createBiquadFilter();
      const g = c.createGain();
      o.type = theme.type;
      o.frequency.value = freq;
      f.type = theme.filter;
      f.frequency.value = theme.filterFreq;
      o.connect(f); f.connect(g); g.connect(masterGain);
      g.gain.setValueAtTime(theme.gain, c.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + theme.tempo/1000 * 0.9);
      o.start(); o.stop(c.currentTime + theme.tempo/1000);
      bgStep++;
      bgTimer = setTimeout(playStep, theme.tempo);
    }

    // Slight delay before starting (let page settle)
    bgTimer = setTimeout(playStep, 800);
  }

  function bgStop() {
    if (bgTimer) { clearTimeout(bgTimer); bgTimer = null; }
    currentTheme = null;
  }

  function syncBtn() {
    const btn = document.getElementById('audioBtn');
    if(btn) btn.textContent = muted ? '🔇' : '🔊';
  }

  function toggle() {
    muted = !muted;
    const c = getCtx();
    if (c && masterGain) {
      masterGain.gain.setTargetAtTime(muted ? 0 : 0.7, c.currentTime, 0.1);
    }
    // Persist preference
    try { localStorage.setItem('cn_muted', muted ? '1' : '0'); } catch(e){}
    return muted;
  }

  function play(sfxName) {
    if (muted) return;
    const fn = SFX[sfxName];
    if (fn) { try { fn(); } catch(e){} }
  }

  // Restore mute preference
  try {
    if (localStorage.getItem('cn_muted') === '1') muted = true;
    syncBtn();
  } catch(e) {}

  return { play, bgStart, bgStop, toggle, unlockOnGesture,
           get muted() { return muted; } };
})();

console.log('[CN Audio] Sound engine ready 🔊');

/* ═══════════════════════════════════════════════════════════
   CN.Inventory — Dual container system + Coins
   
   BASKET  = food items (edible): 8 slots
   TOYBOX  = toy items (tokens, collectibles): 8 slots  
   COINS   = currency earned by completing tasks
   
   When a container is full, items auto-convert to coins (+5 each).
   Both containers render in the bottom bar.
═══════════════════════════════════════════════════════════ */

// Food types go to basket, everything else to toybox
CN.BASKET_TYPES = new Set([
  'cookie','cake','smoothie','salad','veggie_mix','clippings',
  'cooked_egg','cooked_meat','cooked_waffle','cooked_shrimp',
  'carrot','tomato','broccoli','flower','berry','corn',
  'apple','bone','peanut','fish','tomato','herb'
]);

CN.COIN_STORE = 'coins';
CN.MAX_SLOTS  = 8; // per container

/* Get current coin balance */
CN.getCoins = async function() {
  try {
    const db = await CN.Toybox.open();
    return new Promise((res,rej) => {
      if(!db.objectStoreNames.contains(CN.COIN_STORE)){
        res(0); return;
      }
      const tx  = db.transaction(CN.COIN_STORE,'readonly');
      const req = tx.objectStore(CN.COIN_STORE).get('balance');
      req.onsuccess = e => res(e.target.result?.amount || 0);
      req.onerror   = () => res(0);
    });
  } catch(e) { return 0; }
};

/* Add coins */
CN.addCoins = async function(amount) {
  try {
    const db  = await CN.Toybox.open();
    const cur = await CN.getCoins();
    const next = cur + amount;
    return new Promise((res,rej) => {
      if(!db.objectStoreNames.contains(CN.COIN_STORE)){ res(next); return; }
      const tx  = db.transaction(CN.COIN_STORE,'readwrite');
      const req = tx.objectStore(CN.COIN_STORE).put({id:'balance',amount:next});
      req.onsuccess = () => res(next);
      req.onerror   = () => res(cur);
    });
  } catch(e){ return 0; }
};

/* Smart add — routes to basket or toybox based on type, converts overflow to coins */
CN.smartAdd = async function(item) {
  const isFood = CN.BASKET_TYPES.has(item.type);
  const all    = await CN.Toybox.getAll();
  const inCat  = all.filter(i => CN.BASKET_TYPES.has(i.type) === isFood);
  
  if(inCat.length >= CN.MAX_SLOTS) {
    // Container full — convert to coins
    const coins = await CN.addCoins(5);
    CN.Room.greet(`${item.emoji} ${isFood?'Basket':'Toybox'} full! +5 🪙 Coins! (${coins} total)`);
    CN.updateCoinDisplay();
    return -2; // -2 = converted to coins
  }
  
  const slot = await CN.Toybox.add(item);
  return slot;
};

/* Render both bars */
CN.renderBothBars = async function() {
  await renderToyboxBar();
  await CN.renderBasketBar();
  await CN.updateCoinDisplay();
};

CN.renderBasketBar = async function() {
  const bar = document.getElementById('basket-bar');
  if(!bar) return;
  const all   = await CN.Toybox.getAll();
  const foods = all.filter(i => CN.BASKET_TYPES.has(i.type));
  const slots = Array(CN.MAX_SLOTS).fill(null);
  foods.forEach((item,i) => { if(i < CN.MAX_SLOTS) slots[i] = item; });
  bar.innerHTML = slots.map((item,i) => `
    <div class="tb-slot ${item?'filled':''}" onclick="CN._slotTap(${i},true)"
         title="${item?item.name:'Empty basket slot '+(i+1)}">
      ${item?`<span class="tb-emoji">${item.emoji}</span>`:''}
      <span class="tb-num">${i+1}</span>
    </div>
  `).join('');
};

CN.updateCoinDisplay = async function() {
  const coins = await CN.getCoins();
  const el    = document.getElementById('coin-display');
  if(el) {
    el.textContent = '🪙 '+coins;
    if(window.gsap && coins>0) gsap.fromTo(el,{scale:1.2},{scale:1,duration:.3,ease:'back.out(2)'});
  }
};

// Override _slotTap to handle basket param
const _origSlotTap = CN._slotTap;
CN._slotTap = async function(idx, isBasket=false) {
  const all   = await CN.Toybox.getAll();
  const typed = isBasket ? all.filter(i=>CN.BASKET_TYPES.has(i.type)) : all.filter(i=>!CN.BASKET_TYPES.has(i.type));
  const item  = typed[idx];
  if(item){
    CN.Room.greet(`${item.emoji} ${item.name}! Tap animals to use it! 🎒`);
    CN.FX.haptic('tap');
  } else {
    CN.Room.greet(isBasket ? 'Empty basket slot! Cook food to fill it! 🧺' : 'Empty slot! Collect items to fill it! 🧸');
  }
};

console.log('[CN Inventory] Basket + Toybox + Coins ready 🪙');

/* ═══════════════════════════════════════════════════════════
   CN.Coins — Simple coin economy
   Earned by: completing tasks, converting overflow items
   Stored in:  localStorage (simple, no DB needed)
   Spent on:   future shop (v4)
═══════════════════════════════════════════════════════════ */
CN.Coins = (() => {
  const KEY = 'cn_coins';

  function get() {
    try { return parseInt(localStorage.getItem(KEY)||'0',10); } catch(e){ return 0; }
  }

  function add(amount, reason='') {
    const current = get();
    const next    = current + amount;
    try { localStorage.setItem(KEY, next); } catch(e){}
    console.log(`[Coins] +${amount} (${reason}) → total: ${next}`);
    // Trigger coin update event so any open HUD can refresh
    document.dispatchEvent(new CustomEvent('cn:coins', { detail: { coins: next, delta: amount } }));
    return next;
  }

  function spend(amount) {
    const current = get();
    if(current < amount) return false;
    try { localStorage.setItem(KEY, current - amount); } catch(e){}
    document.dispatchEvent(new CustomEvent('cn:coins', { detail: { coins: current-amount, delta: -amount } }));
    return true;
  }

  function reset() {
    try { localStorage.removeItem(KEY); } catch(e){}
  }

  return { get, add, spend, reset };
})();

/* Auto-update coin display whenever CN.Coins changes */
document.addEventListener('cn:coins', (e) => {
  const el = document.getElementById('coin-display');
  if (el) el.textContent = '🪙 ' + e.detail.coins;
});


/* ═══════════════════════════════════════════════════════════
   CN.Hotspots — Room-level clickable zone system
   
   Each room defines hotspots as % positions over its bg.png.
   Tapping a hotspot opens the matching activity panel.
   Same drag-detection as the neighborhood map zones.

   Usage:
     CN.Hotspots.init('kitchen', HOTSPOTS, openActivity);
     
   HOTSPOT shape:
   { id, emoji, label, cx, cy, rx, ry }
   cx/cy = center % of bg image, rx/ry = radius %
═══════════════════════════════════════════════════════════ */
CN.Hotspots = (() => {

  let _container = null;
  let _callback   = null;
  let _hotspots   = [];
  let _editMode   = false;

  function init(roomId, hotspots, onTap, container) {
    _hotspots  = hotspots;
    _callback  = onTap;
    _container = container || document.getElementById('hs-layer');
    if (!_container) return;

    _container.innerHTML = '';
    _container.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:4;';

    hotspots.forEach(hs => {
      const el = document.createElement('div');
      el.className = 'hs-zone';
      el.id = 'hs_' + hs.id;
      el.style.cssText = `
        position:absolute;
        left:${hs.cx - hs.rx}%;
        top:${hs.cy  - hs.ry}%;
        width:${hs.rx * 2}%;
        height:${hs.ry * 2}%;
        border-radius:50%;
        cursor:pointer;
        pointer-events:all;
        display:flex;
        align-items:center;
        justify-content:center;
        flex-direction:column;
        gap:2px;
        transition:transform .15s, background .15s;
        -webkit-tap-highlight-color:transparent;
        touch-action:manipulation;
      `;

      const label = document.createElement('div');
      label.className = 'hs-label';
      label.innerHTML = `<span class="hs-emoji">${hs.emoji}</span><span class="hs-text">${hs.label}</span>`;
      el.appendChild(label);

      // Pulse ring indicator
      const ring = document.createElement('div');
      ring.className = 'hs-ring';
      el.appendChild(ring);

      // Pointer interaction - drag detection
      let moved = false, startX = 0, startY = 0;
      el.addEventListener('pointerdown', e => {
        moved = false;
        startX = e.clientX; startY = e.clientY;
        if (window.gsap) gsap.to(el, {scale:.9, duration:.08});
      });
      el.addEventListener('pointermove', e => {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) > 8) moved = true;
      });
      el.addEventListener('pointerup', e => {
        if (window.gsap) gsap.to(el, {scale:1, duration:.2, ease:'back.out(2)'});
        if (!moved) {
          CN.FX.haptic('tap');
          CN.Audio.play('tap');
          if (window.gsap) CN.Anim.pop(el);
          spawnZapParticles(e.clientX, e.clientY, hs.emoji);
          if (_callback) _callback(hs.id, hs);
        }
      });

      _container.appendChild(el);

      // Stagger entrance animation
      if (window.gsap) {
        gsap.fromTo(el,
          { scale:0, opacity:0 },
          { scale:1, opacity:1, duration:.5, ease:'back.out(2.5)',
            delay: hotspots.indexOf(hs) * 0.1 + 0.3 }
        );
      }
    });
  }

  function highlight(id) {
    document.querySelectorAll('.hs-zone').forEach(z => z.classList.remove('hs-active'));
    const el = document.getElementById('hs_' + id);
    if (el) {
      el.classList.add('hs-active');
      if (window.gsap) gsap.fromTo(el, {scale:1.1}, {scale:1, duration:.3, ease:'back.out(2)'});
    }
  }

  function spawnZapParticles(x, y, emoji) {
    for (let i = 0; i < 6; i++) {
      const p = document.createElement('div');
      p.style.cssText = `position:fixed;left:${x}px;top:${y}px;font-size:1rem;pointer-events:none;z-index:9999;`;
      p.textContent = ['✨','⭐','💫','🌟','⚡'][i % 5];
      document.body.appendChild(p);
      if (window.gsap) {
        const angle = (i / 6) * Math.PI * 2;
        gsap.to(p, {
          x: Math.cos(angle) * 40, y: Math.sin(angle) * 40 - 20,
          opacity:0, scale:.3, duration:.5, ease:'power2.out',
          delay: i * .04, onComplete: () => p.remove()
        });
      } else {
        setTimeout(() => p.remove(), 600);
      }
    }
  }

  return { init, highlight };
})();
