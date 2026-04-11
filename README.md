# 🏘️ Cathy's Neighborhood — v1.0

## What's In This Build
- **Full PWA shell** with Service Worker (offline-first, cache-first)
- **Isometric neighborhood map** — pan (drag), zoom (pinch/scroll/buttons)
- **8 room stubs** — all tappable with modal cards showing features
- **Parent Gate** — hold the 🏠 button 3 seconds to access settings/reset
- **Digital Toybox** — 5-slot bar at the bottom (pipeline-ready)
- **Mini-map** — live viewport tracker, bottom right
- **Time-aware greeting** — different message morning/afternoon/evening/night
- **Haptic feedback** on room tap and toybox actions

## Deployment to GitHub Pages

1. Copy all files to your repo: `johnlaz.github.io/cathys-neighborhood/`
2. Push to GitHub — Pages deploys automatically
3. PWA installs: visit on iPhone/Android → Add to Home Screen
4. **Requires HTTPS** for Service Worker (GitHub Pages provides this automatically)

### File Structure
```
cathys-neighborhood/
├── index.html       ← Main app (single file)
├── sw.js            ← Service Worker
├── manifest.json    ← PWA manifest
├── icons/           ← Create this folder, add icon-192.png & icon-512.png
│   ├── icon-192.png
│   └── icon-512.png
└── rooms/           ← Room modules go here (v2+)
    ├── kitchen/
    ├── garage/
    └── ...
```

### Icons
You need two PNG icons. Use any emoji-to-PNG tool or create them in Canva:
- `icons/icon-192.png` — 192×192px, use 🏘️ on purple (#1a0533) background
- `icons/icon-512.png` — 512×512px, same design

## What's Next (v2 — Room Modules)

Each room is a separate `rooms/{id}/index.html` file using the same:
- CSS design tokens (same fonts, same dark purple sky palette)
- `Item` class for drag-and-drop / toybox pipeline
- Back button → returns to map

### Recommended Build Order
1. **Little Chef Kitchen** — validates the Toybox pipeline (bake → feed to pets)
2. **Pet Sanctuary** — receives items from Kitchen, drag-and-drop feeding
3. **Royal Salon** — Magic Brush painting (simpler, quick win)
4. **Music Lab** — Loop Launcher with Tone.js
5. **Garage + 3D Print Lab** — Haptic drill interactions
6. **Tesla/Hummer Station** — Reveal-the-color wash mechanic
7. **Mower Shed** — Simplest room, save for last

## Parent Gate
- **Hold the 🏠 button for 3 seconds** → settings panel opens
- Options: Reset all progress (clears IndexedDB + localStorage)
- To add more parent settings, edit the `#parent-gate` section in index.html

## Audio (v2)
All sounds are architected but silent in v1. In v2:
- Place MP3 files in `/audio/`
- Web Audio API with preloading on first tap (iOS requires user gesture)
- File naming convention: `action_great-job.mp3`, `room_kitchen.mp3`, `safety_hot.mp3`

## Design Notes
- **Fonts**: Fredoka One (titles) + Nunito (body) — loaded from Google Fonts
- **World size**: 3000×2200px virtual canvas
- **Sky**: Deep purple/indigo gradient → star field + moon
- **Ground**: Emerald green with golden paths connecting all buildings
- **Buildings**: Isometric-style CSS SVG with unique personality per room
