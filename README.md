---
title: LeadScrapper Pro
emoji: ⚡
colorFrom: indigo
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

# 🎯 LeadScrapper

A full-stack lead-generation tool that scrapes **Google Maps** to find businesses **without websites** — so you can pitch website-building services to them.

![Stack](https://img.shields.io/badge/Google_Maps-Direct_Scraper-red) ![Stack](https://img.shields.io/badge/React-18-blue) ![Stack](https://img.shields.io/badge/Node.js-Express-green) ![Stack](https://img.shields.io/badge/Tailwind-3-purple)

---

## Features

| Feature | Description |
|---------|-------------|
| **Google Maps Direct Engine** | Scrapes Google Maps directly using local Chrome/Edge in headless mode — **no paid API key required!** |
| **Smart Two-Field Form** | Auto-suggest for business categories & locations with keyboard navigation |
| **Strict Website Filter** | Keeps businesses with no website or only social profiles (Facebook, Instagram, Justdial). Excludes legitimate sites. |
| **Real-Time Streaming** | Leads stream onto your screen via WebSocket progressively as they are found on Google Maps |
| **Direct Maps Links** | Every lead includes a direct clickable `https://www.google.com/maps/place/...` link |
| **Multi-Part PDF Export** | Download leads as PDF(s) — auto-splits batches > 200 leads into multiple PDFs and zips them |

---

## Tech Stack

- **Backend**: Node.js, Express, WebSocket (`ws`), `puppeteer-core` (uses local Chrome / Edge), PDFKit, Archiver
- **Frontend**: React 18 (Vite), Tailwind CSS, Axios
- **Scraping Sources**:
  1. **Google Maps** (Primary: direct headless browser scraping)
  2. **Google Places API** (Optional: if `GOOGLE_API_KEY` is provided)
  3. **OpenStreetMap Nominatim** (Fallback)

---

## Quick Start

### 1. Install dependencies

```powershell
npm install
cd client && npm install && cd ..
```

### 2. Run in Development Mode

Open two terminal tabs in `e:\Projects\leadScrapper`:

```powershell
# Terminal 1 — Start Backend Server (port 4000)
npm run dev

# Terminal 2 — Start Frontend Client (port 5173)
npm run client
```

Open **`http://localhost:5173`** in your browser.

### 3. Production Mode

```powershell
npm run build    # Compiles client into client/dist
npm start        # Serves both API and UI on http://localhost:4000
```

---

## License

MIT — feel free to use and adapt for your outreach workflow.
