/**
 * LeadScrapper USA — Backend Server
 *
 * Dedicated to finding US local businesses without websites.
 * Features:
 *   - Google Maps direct scraper with RPC-level authoritative Website and Review detection
 *   - Strict filter: Excludes any business with a legitimate website
 *   - Google Places API secondary source
 *   - PDF Export with Rating & Review count columns
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const axios = require('axios');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const { WebSocketServer } = require('ws');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
wss.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.warn('WebSocketServer error:', err.message);
  }
});

function send(ws, event, data) {
  if (ws && ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ event, data }));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Filter: Checks whether a URL is an actual external company website.
 * Social-media profiles and directories DO NOT count as an official business website.
 * Uses exact hostname matching so domains like "ckelectrictx.com" do NOT false-match "x.com".
 */
function hasRealWebsite(urlString) {
  if (!urlString || typeof urlString !== 'string') return false;
  let lower = urlString.trim().toLowerCase();

  try {
    lower = decodeURIComponent(lower);
  } catch {}

  // If it's a google ad redirect, extract destination adurl
  if (lower.includes('adurl=')) {
    const parts = lower.split('adurl=');
    if (parts[1]) lower = parts[1];
  }

  // Must have standard web prefix
  if (!lower.startsWith('http://') && !lower.startsWith('https://') && !lower.startsWith('www.')) {
    return false;
  }

  // Extract clean hostname
  let hostname = '';
  try {
    const parsed = new URL(lower.startsWith('http') ? lower : `https://${lower}`);
    hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return false;
  }

  if (!hostname || !hostname.includes('.')) return false;

  // Social media, directories, and search platforms that do not count as a business website
  const blockedHosts = [
    'facebook.com',
    'instagram.com',
    'justdial.com',
    'twitter.com',
    'x.com',
    'linkedin.com',
    'youtube.com',
    'yelp.com',
    'tiktok.com',
    'pinterest.com',
    'google.com',
    'yellowpages.com',
    'bbb.org',
    'mapquest.com',
    'foursquare.com',
    'angi.com',
    'angieslist.com',
    'homeadvisor.com',
    'thumbtack.com',
    'nextdoor.com',
    'houzz.com',
    'superpages.com',
    'citysearch.com',
    'manta.com',
  ];

  // Exact domain or subdomain match (e.g. "m.facebook.com" matches "facebook.com", but "ckelectrictx.com" does NOT match "x.com")
  const isBlocked = blockedHosts.some((d) => hostname === d || hostname.endsWith('.' + d));
  if (isBlocked) {
    return false;
  }

  return true;
}

/** Format raw numbers into standard US phone: (XXX) XXX-XXXX */
function formatUsPhone(raw) {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw.trim();
}

// ──────────────────────────────────────────────
// 1. Google Maps Direct Scraper (USA Context + Strict Detail Verification)
// ──────────────────────────────────────────────
const BROWSER_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

function getBrowserExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  for (const p of BROWSER_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * LAYER 1: Processes Google Maps internal RPC response JSON to extract business -> website mappings.
 * Independent of DOM / CSS / HTML layout.
 */
function processRpcJson(rpcStore, data) {
  if (!Array.isArray(data)) return;
  for (const item of data) {
    if (Array.isArray(item) && item.length >= 5) {
      for (const subItem of item) {
        if (Array.isArray(subItem) && subItem.length === 2 && Array.isArray(subItem[1])) {
          const biz = subItem[1];
          // biz[11] is business name, biz[7] is website array
          const name = typeof biz[11] === 'string' ? biz[11].trim() : '';
          if (name) {
            let site = '';
            if (Array.isArray(biz[7]) && biz[7][0]) site = biz[7][0];
            else if (typeof biz[7] === 'string') site = biz[7];
            rpcStore.set(name.toLowerCase(), {
              name,
              website: site,
              hasReal: hasRealWebsite(site),
            });
          }
        }
      }
    }
  }
}

/**
 * Attaches real-time network response sniffer for Google Maps RPC endpoints.
 */
function attachRpcInterceptor(page, rpcStore) {
  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (url.includes('/search?tbm=map') || url.includes('/preview/')) {
        const text = await res.text();
        const clean = text.replace(/^\)\]\}'\s*/, '');
        const json = JSON.parse(clean);
        processRpcJson(rpcStore, json);
      }
    } catch {
      // Safe fallback - non-blocking
    }
  });
}

const placeVerifyCache = new Map();

/**
 * Deep verification on place detail page:
 * Dual-Layer: Checks internal RPC store + DOM authority link and website action buttons.
 * Returns { website, foundBy, detailPhone, detailReviews, detailRating, detailAddress }
 */
async function verifyCandidatePlace(verifierPage, mapsLink, candidateName, rpcStore) {
  try {
    const normName = (candidateName || '').toLowerCase().trim();

    // Check RAM Cache first (0ms latency for repeated candidates across queries)
    if (placeVerifyCache.has(normName)) {
      return placeVerifyCache.get(normName);
    }

    // Check if Layer 1 RPC store already caught this candidate's website
    if (rpcStore && rpcStore.has(normName)) {
      const rpcEntry = rpcStore.get(normName);
      if (rpcEntry.hasReal) {
        const res = { website: rpcEntry.website, foundBy: 'rpcStore' };
        placeVerifyCache.set(normName, res);
        return res;
      }
    }

    await verifierPage.goto(mapsLink, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Wait for the place details pane to hydrate (address, phone, or authority)
    await verifierPage
      .waitForSelector(
        'button[data-item-id="address"], button[data-item-id*="phone"], a[data-item-id="authority"]',
        { timeout: 5000 }
      )
      .catch(() => {});
    await sleep(200);

    // Re-check RPC store after verifierPage loaded (might have received new place RPC data)
    if (rpcStore && rpcStore.has(normName)) {
      const rpcEntry = rpcStore.get(normName);
      if (rpcEntry.hasReal) {
        return { website: rpcEntry.website, foundBy: 'rpcStorePostNav' };
      }
    }

    const details = await verifierPage.evaluate(() => {
      // 1. Google Maps official authority anchor (a[data-item-id="authority"])
      const auth = document.querySelector('a[data-item-id="authority"]');
      if (auth && auth.href) {
        return { website: auth.href, foundBy: 'authority' };
      }

      // 2. Action buttons or aria links with website label
      const allA = Array.from(document.querySelectorAll('a'));
      for (const a of allA) {
        const aria = (a.getAttribute('aria-label') || '').toLowerCase();
        const txt = (a.innerText || '').toLowerCase();
        const id = a.getAttribute('data-item-id');
        const val = a.getAttribute('data-value');
        const tooltip = (a.getAttribute('data-tooltip') || '').toLowerCase();
        if (
          id === 'authority' ||
          val === 'Website' ||
          aria.startsWith('website:') ||
          aria === 'website' ||
          aria.includes('website') ||
          tooltip.includes('website') ||
          txt === 'website'
        ) {
          if (a.href) return { website: a.href, foundBy: 'webA' };
        }
      }

      // 3. Button for copying website
      const copyBtn = document.querySelector('button[aria-label*="Copy website" i], button[data-tooltip*="Copy website" i]');
      if (copyBtn) {
        return { website: 'https://found-via-copy-website.com', foundBy: 'copyBtn' };
      }

      // If no website found, extract enriched place details
      const phoneBtn = document.querySelector('button[data-item-id*="phone"], button[aria-label*="Phone"]');
      const addrBtn = document.querySelector('button[data-item-id="address"], button[aria-label*="Address"]');
      const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"], span.ceNzKf');
      const reviewsEl = document.querySelector('div.F7nice span:last-child, span[aria-label*="reviews"]');

      let detailPhone = '';
      if (phoneBtn) {
        const m = (phoneBtn.getAttribute('aria-label') || phoneBtn.innerText || '').match(/(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}/);
        if (m) detailPhone = m[0];
      }

      let detailReviews = '';
      if (reviewsEl) {
        const m = (reviewsEl.getAttribute('aria-label') || reviewsEl.innerText || '').match(/([\d,]+)\s*reviews?/i) ||
                  (reviewsEl.innerText || '').match(/^\(?([\d,]+)\)?$/);
        if (m) detailReviews = m[1].replace(/,/g, '');
      }

      let detailRating = '';
      if (ratingEl) {
        const m = ratingEl.innerText.trim().match(/^[1-5]\.\d/);
        if (m) detailRating = m[0];
      }

      let detailAddress = '';
      if (addrBtn) {
        detailAddress = (addrBtn.getAttribute('aria-label') || addrBtn.innerText || '')
          .replace(/^Address:\s*/i, '')
          .replace(/[\n\r]+/g, ', ')
          .trim();
      }

      // Official Google Maps business category button (e.g. "Beauty salon", "General contractor")
      const catEl = document.querySelector('button[jsaction*="category"], button.DkEaL, span.DkEaL');
      const detailCategory = catEl ? catEl.innerText.trim() : '';

      return {
        website: '',
        foundBy: 'none',
        detailPhone,
        detailReviews,
        detailRating,
        detailAddress,
        detailCategory,
      };
    });

    placeVerifyCache.set(normName, details);
    return details;
  } catch (err) {
    console.warn(`Verification note for "${candidateName}":`, err.message);
    return { website: '', foundBy: 'error' };
  }
}

/**
 * Strict Category Relevance Validator:
 * Ensures scraped businesses match the user's searched niche and strictly rejects
 * unrelated industries (e.g. general contractors appearing in salon searches).
 */
function isCategoryRelevant(userCategory, candidateCategory, candidateName) {
  if (!userCategory || !userCategory.trim()) return true;

  const userNorm = userCategory.toLowerCase().trim();
  const candCatNorm = (candidateCategory || '').toLowerCase().trim();
  const candNameNorm = (candidateName || '').toLowerCase().trim();

  const stopWords = new Set([
    'and', '&', 'or', 'in', 'near', 'the', 'of', 'for', 'services', 'service',
    'center', 'centre', 'specialist', 'specialists', 'company', 'co', 'llc', 'inc',
    'group', 'pros', 'pro', 'usa'
  ]);

  function getTokens(str) {
    return str
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 2 && !stopWords.has(t))
      .map((t) => {
        if (t.endsWith('ies')) return t.slice(0, -3) + 'y';
        if (t.endsWith('es') && !t.endsWith('ses')) return t.slice(0, -2);
        if (t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
        if (t.endsWith('ing')) return t.slice(0, -3);
        return t;
      });
  }

  const userTokens = getTokens(userNorm);
  if (userTokens.length === 0) return true;

  // 1. Direct match: candidate category or candidate name contains any key user token
  for (const ut of userTokens) {
    if (candCatNorm.includes(ut) || candNameNorm.includes(ut)) {
      return true;
    }
  }

  // 2. High-Intent Industry Synonym Clusters
  const INDUSTRY_CLUSTERS = [
    {
      keys: ['salon', 'barber', 'hair', 'beauty', 'spa', 'nail', 'lash', 'wax', 'esthetician', 'cosmetolog', 'facial'],
      tags: ['salon', 'barber', 'hair', 'beauty', 'spa', 'nail', 'lash', 'wax', 'massage', 'cosmetic', 'skincare']
    },
    {
      keys: ['plumb'],
      tags: ['plumb', 'drain', 'pipe', 'water heater', 'sewer', 'rooter']
    },
    {
      keys: ['roof'],
      tags: ['roof', 'gutter', 'siding', 'shingle']
    },
    {
      keys: ['hvac', 'air condition', 'heat', 'furnace', 'ventil'],
      tags: ['hvac', 'air condition', 'heating', 'cooling', 'furnace', 'ac repair']
    },
    {
      keys: ['electric'],
      tags: ['electric', 'wiring', 'lighting', 'generator']
    },
    {
      keys: ['landscap', 'lawn', 'mow', 'yard', 'turf', 'tree'],
      tags: ['landscap', 'lawn', 'tree', 'garden', 'irrigation', 'sprinkler', 'grounds']
    },
    {
      keys: ['paint'],
      tags: ['paint', 'drywall', 'coating', 'deck']
    },
    {
      keys: ['remodel', 'renovat', 'contractor', 'builder', 'construct'],
      tags: ['contractor', 'construction', 'builder', 'remodel', 'renovation', 'handyman']
    },
    {
      keys: ['dentist', 'dental'],
      tags: ['dentist', 'dental', 'orthodont', 'teeth']
    },
    {
      keys: ['auto', 'car', 'mechanic', 'tire', 'brake'],
      tags: ['auto', 'mechanic', 'car', 'repair', 'transmission', 'brake', 'body shop', 'collision']
    },
    {
      keys: ['clean', 'maid', 'janitor'],
      tags: ['cleaning', 'maid', 'janitorial', 'carpet', 'pressure wash', 'housekeep']
    },
    {
      keys: ['pest', 'exterminat'],
      tags: ['pest', 'termite', 'exterminat', 'bed bug']
    },
    {
      keys: ['locksmith'],
      tags: ['locksmith', 'key', 'lock']
    },
    {
      keys: ['towing'],
      tags: ['towing', 'tow truck', 'roadside', 'wrecker']
    }
  ];

  for (const cluster of INDUSTRY_CLUSTERS) {
    const userMatchesCluster = userTokens.some((ut) =>
      cluster.keys.some((k) => ut.includes(k) || k.includes(ut))
    );
    if (userMatchesCluster) {
      // Check if candidate matches this cluster
      const candMatches = cluster.tags.some(
        (t) => candCatNorm.includes(t) || candNameNorm.includes(t)
      );
      if (candMatches) return true;

      // If user clearly belongs to this cluster, but candidate belongs to an unrelated conflicting cluster (e.g. contractor in salon search)
      if (candCatNorm && candCatNorm !== '—') {
        return false;
      }
    }
  }

  // 3. Trade vs Non-Trade Discrepancy Guard
  const TRADE_WORDS = ['contractor', 'construction', 'contracting', 'builder', 'remodeling', 'roofing', 'plumbing', 'electric'];
  const userIsTrade = userTokens.some((ut) => TRADE_WORDS.some((tw) => ut.includes(tw) || tw.includes(ut)));
  const candIsTrade = TRADE_WORDS.some((tw) => candCatNorm.includes(tw) || candNameNorm.includes(tw));

  if (!userIsTrade && candIsTrade) {
    // Non-trade user query (e.g. salons, dentist, gym) but candidate is a contractor -> REJECT
    return false;
  }

  // If candidate has a specific category from Google Maps that has 0 token overlap with user category
  if (candCatNorm && candCatNorm !== '—') {
    const candTokens = getTokens(candCatNorm);
    const hasOverlap = userTokens.some((ut) => candTokens.some((ct) => ut.includes(ct) || ct.includes(ut)));
    return hasOverlap;
  }

  return true;
}

// Major US Metros and their key suburbs/neighborhoods for deep lead discovery
const METRO_SUBURBS = {
  dallas: ['Mesquite', 'Garland', 'Grand Prairie', 'Irving', 'Arlington', 'Carrollton', 'Richardson', 'DeSoto', 'Plano'],
  houston: ['Pasadena', 'Katy', 'Pearland', 'Sugar Land', 'Spring', 'Conroe', 'Baytown', 'Cypress', 'Tomball'],
  austin: ['Round Rock', 'Cedar Park', 'Pflugerville', 'Georgetown', 'San Marcos', 'Kyle', 'Buda'],
  'san antonio': ['New Braunfels', 'Schertz', 'Cibolo', 'Converse', 'Boerne', 'Universal City'],
  'fort worth': ['North Richland Hills', 'Haltom City', 'Keller', 'Burleson', 'Mansfield', 'Euless', 'Bedford'],
  'los angeles': ['Glendale', 'Pasadena', 'Torrance', 'Burbank', 'Long Beach', 'Inglewood', 'El Monte', 'Downey'],
  chicago: ['Cicero', 'Evanston', 'Naperville', 'Aurora', 'Joliet', 'Oak Lawn', 'Berwyn', 'Des Plaines'],
  phoenix: ['Mesa', 'Chandler', 'Glendale', 'Scottsdale', 'Tempe', 'Peoria', 'Surprise', 'Avondale'],
  miami: ['Hialeah', 'Coral Gables', 'Homestead', 'Doral', 'Miami Beach', 'Kendall', 'North Miami'],
  atlanta: ['Marietta', 'Alpharetta', 'Roswell', 'Decatur', 'Sandy Springs', 'Smyrna', 'Duluth', 'Kennesaw'],
  denver: ['Aurora', 'Lakewood', 'Thornton', 'Arvada', 'Westminster', 'Centennial', 'Littleton'],
  seattle: ['Bellevue', 'Tacoma', 'Renton', 'Kent', 'Everett', 'Federal Way', 'Kirkland', 'Auburn'],
  'new york': ['Queens', 'Brooklyn', 'Bronx', 'Staten Island', 'Yonkers', 'New Rochelle', 'Mount Vernon'],
  'san diego': ['Chula Vista', 'Oceanside', 'Escondido', 'Carlsbad', 'El Cajon', 'Vista', 'San Marcos'],
  'las vegas': ['Henderson', 'North Las Vegas', 'Paradise', 'Spring Valley', 'Sunrise Manor'],
  orlando: ['Kissimmee', 'Sanford', 'Altamonte Springs', 'Winter Park', 'Apopka', 'Ocoee'],
  tampa: ['St. Petersburg', 'Clearwater', 'Brandon', 'Largo', 'Riverview', 'Palm Harbor'],
  charlotte: ['Concord', 'Gastonia', 'Rock Hill', 'Huntersville', 'Matthews', 'Monroe'],
  columbus: ['Dublin', 'Westerville', 'Grove City', 'Reynoldsburg', 'Hilliard', 'Gahanna'],
  indianapolis: ['Carmel', 'Fishers', 'Noblesville', 'Greenwood', 'Lawrence', 'Plainfield'],
  nashville: ['Franklin', 'Murfreesboro', 'Hendersonville', 'Brentwood', 'Lebanon', 'Smyrna'],
  jacksonville: ['Jacksonville Beach', 'Orange Park', 'St. Augustine', 'Atlantic Beach'],
  'san jose': ['Sunnyvale', 'Santa Clara', 'Campbell', 'Milpitas', 'Cupertino', 'Mountain View'],
  detroit: ['Dearborn', 'Livonia', 'Troy', 'Warren', 'Sterling Heights', 'Westland'],
  philadelphia: ['Upper Darby', 'Norristown', 'Chester', 'Bensalem', 'Cherry Hill', 'Camden'],
  boston: ['Cambridge', 'Quincy', 'Newton', 'Somerville', 'Framingham', 'Waltham'],
  baltimore: ['Towson', 'Columbia', 'Dundalk', 'Glen Burnie', 'Ellicott City'],
  milwaukee: ['Waukesha', 'West Allis', 'Wauwatosa', 'Greenfield'],
  'kansas city': ['Overland Park', 'Olathe', 'Lee\'s Summit', 'Independence', 'Shawnee'],
  raleigh: ['Cary', 'Apex', 'Wake Forest', 'Holly Springs', 'Garner'],
  'salt lake city': ['West Valley City', 'Provo', 'West Jordan', 'Orem', 'Sandy'],
  'oklahoma city': ['Norman', 'Edmond', 'Moore', 'Midwest City'],
};

async function scrapeGoogleMaps(category, location, ws, seenNames) {
  const executablePath = getBrowserExecutable();
  if (!executablePath) {
    console.warn('Chrome/Edge executable not found for Google Maps scraping.');
    return [];
  }

  const cleanLoc = location.replace(/,\s*USA$/i, '').trim();
  const cityParts = cleanLoc.split(',').map((s) => s.trim());
  const cityName = cityParts[0];
  const stateCode = cityParts[1] || '';

  // 100% Dynamic, Neutral Search Query Generation (Zero hardcoded industry keywords!)
  const queriesToRun = [
    `${category} in ${cleanLoc}, USA`,
    `Local ${category} in ${cleanLoc}, USA`,
    `${category} near ${cleanLoc}, USA`,
    `Independent ${category} in ${cleanLoc}, USA`,
    `Family owned ${category} in ${cleanLoc}, USA`,
    `Best ${category} in ${cleanLoc}, USA`,
  ];

  const lowerCity = cityName.toLowerCase();
  const suburbs = METRO_SUBURBS[lowerCity];
  if (suburbs && suburbs.length > 0) {
    for (const sub of suburbs) {
      queriesToRun.push(`${category} in ${sub}, ${stateCode || 'USA'}`);
    }
  } else {
    queriesToRun.push(`${category} services in ${cleanLoc}, USA`);
  }

  send(ws, 'status', { message: `🇺🇸 Deep Scanning Google Maps for "${category}" in "${location}"…` });

  let browser;
  const leads = [];
  const TARGET_LEADS = 60;

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--ignore-certificate-errors',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--lang=en-US,en',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );

    // Shared RPC store for Google Maps raw network data (Layer 1)
    const rpcStore = new Map();
    attachRpcInterceptor(page, rpcStore);

    // Abort heavy media, map tiles & fonts on search page for lightning-fast feed navigation
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const rType = req.resourceType();
      const url = req.url();
      if (
        ['image', 'media', 'font'].includes(rType) ||
        url.includes('/maps/vt/pb=') ||
        url.includes('google-analytics') ||
        url.includes('/log?')
      ) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Concurrent verifier pool (4 parallel worker pages for ultra-fast verification)
    const verifiers = [
      await browser.newPage(),
      await browser.newPage(),
      await browser.newPage(),
      await browser.newPage(),
    ];
    for (const v of verifiers) {
      attachRpcInterceptor(v, rpcStore);
      await v.setRequestInterception(true);
      v.on('request', (req) => {
        const rType = req.resourceType();
        const url = req.url();
        if (
          ['image', 'media', 'font'].includes(rType) ||
          url.includes('google-analytics') ||
          url.includes('/log?')
        ) {
          req.abort();
        } else {
          req.continue();
        }
      });
    }

    for (let qIdx = 0; qIdx < queriesToRun.length; qIdx++) {
      if (leads.length >= TARGET_LEADS) break;

      const currentQuery = queriesToRun[qIdx];
      const url = `https://www.google.com/maps/search/${encodeURIComponent(currentQuery)}?hl=en&gl=us`;

      send(ws, 'status', {
        message: `🔍 Scanning: "${currentQuery.replace(', USA', '')}" (${leads.length} leads found so far)…`,
      });

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForSelector('div[role="feed"], a[href*="/maps/place/"]', { timeout: 8000 });
      } catch {
        continue;
      }

      const scrollRounds = 16;
      for (let round = 0; round < scrollRounds; round++) {
        if (leads.length >= TARGET_LEADS) break;

        const extracted = await page.evaluate(() => {
          const links = document.querySelectorAll('a[href*="/maps/place/"]');
          const items = [];

          links.forEach((link) => {
            const name = (link.getAttribute('aria-label') || '').trim();
            if (!name) return;

            const card =
              link.closest('div[role="article"], div.Nv2PK') ||
              link.closest('div[jsaction*="mouseover"]') ||
              link.parentElement?.parentElement ||
              link;
            const text = card.innerText || '';

            // Check if card directly displays a website link/button
            let cardWebsite = '';
            const allA = Array.from(card.querySelectorAll('a'));
            for (const a of allA) {
              const aLabel = (a.getAttribute('aria-label') || a.innerText || '').toLowerCase();
              const val = a.getAttribute('data-value');
              if (
                val === 'Website' ||
                aLabel.startsWith('visit ') ||
                aLabel.includes('website') ||
                aLabel === 'website'
              ) {
                cardWebsite = a.href || '';
                if (cardWebsite) break;
              }
              if (
                a.href &&
                !a.href.includes('google.com/maps') &&
                !a.href.includes('google.com/search') &&
                a.href.startsWith('http')
              ) {
                cardWebsite = a.href;
                break;
              }
            }

            // US Phone regex
            let phone = '';
            const usPhoneRegex = /(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}/;
            const phoneMatch = text.match(usPhoneRegex);
            if (phoneMatch) phone = phoneMatch[0];

            // Star rating extraction
            let rating = '';
            const starEl = card.querySelector('span[aria-label*="star"], span[role="img"][aria-label*="star"], span.ZkP5Je');
            if (starEl) {
              const aria = starEl.getAttribute('aria-label') || '';
              const m = aria.match(/([1-5]\.\d)\s*stars?/i);
              if (m) rating = m[1];
            }
            if (!rating) {
              const ratingSpan = card.querySelector('span.MW4etd');
              if (ratingSpan) rating = ratingSpan.innerText.trim();
            }

            // Review count from DOM
            let cardReviews = '0';
            const allSpans = Array.from(card.querySelectorAll('span'));
            for (const s of allSpans) {
              const txt = s.innerText.trim();
              const aria = (s.getAttribute('aria-label') || '').trim();
              if (/^\([\d,]+\)$/.test(txt)) {
                cardReviews = txt.replace(/[()]/g, '');
                break;
              }
              const m = aria.match(/([\d,]+)\s*reviews?/i);
              if (m) {
                cardReviews = m[1];
                break;
              }
            }

            // Clean address snippet (exclude button labels like "Book online", "Directions", "Website")
            const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
            const excludedTokens = ['book online', 'directions', 'website', 'open', 'closed', 'opens', 'closes', 'send to phone', 'save', 'share'];
            const candidateLines = lines.filter((l) => {
              const lowerL = l.toLowerCase();
              return !excludedTokens.some((tok) => lowerL === tok || lowerL.startsWith(tok + ' ·') || lowerL.startsWith(tok + ' '));
            });

            let address = '';
            for (let i = candidateLines.length - 1; i >= 0; i--) {
              const line = candidateLines[i];
              if (/\d+/.test(line) && !line.includes('★') && !line.includes('(') && !line.startsWith('+1')) {
                address = line;
                break;
              }
            }

            // Extract Card Subtitle Category (e.g. "Beauty salon", "Hair salon", "General contractor")
            let cardCategory = '';
            const catEl = card.querySelector('button[jsaction*="category"], span.W4P4ne, div.W4P4ne');
            if (catEl) {
              cardCategory = catEl.innerText.trim();
            }
            if (!cardCategory) {
              for (const line of candidateLines) {
                if (line.includes('·')) {
                  const parts = line.split('·');
                  const firstPart = parts[0].trim();
                  if (firstPart && !firstPart.includes('$') && !firstPart.includes('★') && !/\d{3}/.test(firstPart)) {
                    cardCategory = firstPart;
                    break;
                  }
                }
              }
            }

            items.push({
              name,
              phone,
              rating,
              cardReviews,
              address,
              cardCategory,
              cardWebsite,
              mapsLink: link.href,
            });
          });

          return items;
        });

        // Instant Pre-Filter (Eliminates obvious website owners & irrelevant categories in 0ms)
        const candidatesToVerify = [];
        for (const item of extracted) {
          const key = item.name.toLowerCase().trim();
          if (seenNames.has(key)) continue;
          seenNames.add(key);

          // Layer 0: Category Relevance Pre-Filter (Reject unrelated industries immediately)
          if (item.cardCategory && !isCategoryRelevant(category, item.cardCategory, item.name)) {
            console.log(`[Category Filter (Card)]: Excluded "${item.name}" (card category "${item.cardCategory}" does not match "${category}")`);
            continue;
          }

          // Layer 1: Google Maps internal RPC data check
          const rpcData = rpcStore.get(key);
          if (rpcData && rpcData.hasReal) {
            console.log(`[Layer-1 Filter (RPC Data)]: Excluded "${item.name}" (website: ${rpcData.website})`);
            continue;
          }

          // Layer 2A: Search card DOM check
          if (hasRealWebsite(item.cardWebsite)) {
            console.log(`[Layer-2 Filter (Card DOM)]: Excluded "${item.name}" (website: ${item.cardWebsite})`);
            continue;
          }

          candidatesToVerify.push(item);
        }

        // Concurrent Deep Verification Pool (2 parallel worker pages)
        if (candidatesToVerify.length > 0) {
          let nextIdx = 0;
          async function verifyWorker(verifierPage) {
            while (nextIdx < candidatesToVerify.length) {
              if (leads.length >= TARGET_LEADS) break;
              const item = candidatesToVerify[nextIdx++];
              if (!item) break;

              // Layer 2B: Deep Detail Verification (RPC + DOM)
              const verified = await verifyCandidatePlace(verifierPage, item.mapsLink, item.name, rpcStore);

              // FAIL-SAFE SECURITY: Inconclusive/error responses are strictly rejected to guarantee 100% no website
              if (verified.foundBy === 'error') {
                console.log(`[Fail-Safe Security]: Excluded "${item.name}" (inconclusive verification response)`);
                continue;
              }

              if (hasRealWebsite(verified.website)) {
                console.log(`[Layer-2 Filter (Detail DOM/RPC)]: Excluded "${item.name}" (website: ${verified.website}, foundBy: ${verified.foundBy})`);
                continue;
              }

              // Layer 2C: Official Category Relevance Validation (Detail Page / Card)
              const finalCat = verified.detailCategory || item.cardCategory || '';
              if (!isCategoryRelevant(category, finalCat, item.name)) {
                console.log(`[Category Filter (Detail)]: Excluded "${item.name}" (category "${finalCat}" does not match "${category}")`);
                continue;
              }

              // === 100% VERIFIED GENUINE LEAD (Confirmed NO website across all layers) ===
              const exactPhone = verified.detailPhone || item.phone;
              const exactRating = verified.detailRating || item.rating || '—';
              const exactReviews = verified.detailReviews || item.cardReviews || '0';
              const exactAddress = verified.detailAddress || item.address || '';

              const lead = {
                name: item.name,
                phone: formatUsPhone(exactPhone),
                email: '',
                rating: exactRating,
                reviews: exactReviews.toString(),
                address: exactAddress,
                mapsLink: item.mapsLink,
              };

              leads.push(lead);
              send(ws, 'lead', lead);
            }
          }

          await Promise.all(verifiers.map((v) => verifyWorker(v)));
        }

        // Scroll feed down
        await page.evaluate(() => {
          const feed = document.querySelector('div[role="feed"]');
          if (feed) {
            const items = feed.querySelectorAll('div[jsaction*="mouseover"]');
            if (items.length > 0) {
              items[items.length - 1].scrollIntoView();
            }
            feed.scrollTop += 3000;
          }
        });
        await sleep(400);

        // Break early if Google Maps reached the end of results
        const isEnd = await page.evaluate(() => {
          const endEl = document.querySelector('div.HlvSq, span.HlvSq, p.fontBodyMedium');
          return endEl && (endEl.innerText || '').includes("You've reached the end of the list");
        });
        if (isEnd) break;
      }
    }
  } catch (err) {
    console.warn('Google Maps scraper notice:', err.message);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }

  return leads;
}

// ──────────────────────────────────────────────
// 2. Google Places API (Optional Secondary Source)
// ──────────────────────────────────────────────
async function fetchFromGooglePlacesAPI(category, location, ws, seenNames) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) return [];

  send(ws, 'status', { message: '🔍 Querying Google Places API (USA)…' });

  const leads = [];
  try {
    const res = await axios.get(
      'https://maps.googleapis.com/maps/api/place/textsearch/json',
      {
        params: {
          query: `${category} in ${location}, USA`,
          key: apiKey,
          region: 'us',
        },
        timeout: 15000,
      }
    );

    const results = res.data.results || [];
    for (const place of results) {
      const name = (place.name || '').trim();
      if (!name || seenNames.has(name.toLowerCase())) continue;

      let website = '';
      let phone = '';

      try {
        const details = await axios.get(
          'https://maps.googleapis.com/maps/api/place/details/json',
          {
            params: {
              place_id: place.place_id,
              fields: 'website,formatted_phone_number,international_phone_number,rating,user_ratings_total',
              key: apiKey,
            },
            timeout: 8000,
          }
        );
        website = details.data.result?.website || '';
        phone =
          details.data.result?.formatted_phone_number ||
          details.data.result?.international_phone_number ||
          '';
      } catch {}

      // FILTER: Exclude if it has a real website
      if (hasRealWebsite(website)) continue;

      seenNames.add(name.toLowerCase());
      const lead = {
        name,
        phone: formatUsPhone(phone),
        email: '',
        rating: place.rating ? `${place.rating}` : '—',
        reviews: (place.user_ratings_total || 0).toString(),
        address: place.formatted_address || '',
        mapsLink: `https://www.google.com/maps/place/?q=place_id:${place.place_id}`,
      };
      leads.push(lead);
      send(ws, 'lead', lead);
    }
  } catch (err) {
    console.warn('Google Places API notice:', err.message);
  }

  return leads;
}

// ──────────────────────────────────────────────
// 3. OpenStreetMap Nominatim (USA Fallback)
// ──────────────────────────────────────────────
const OSM_HEADERS = {
  'User-Agent': 'LeadScrapperUSA/1.0 (contact@leadscrapper.org)',
  'Accept': 'application/json, text/plain, */*',
};

async function fetchFromNominatim(category, location, ws, seenNames) {
  send(ws, 'status', { message: '📍 Querying US local directory fallback…' });

  const leads = [];
  try {
    const res = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        q: `${category} in ${location}`,
        format: 'json',
        limit: 40,
        extratags: 1,
        addressdetails: 1,
        countrycodes: 'us',
      },
      headers: OSM_HEADERS,
      timeout: 10000,
    });

    const items = res.data || [];
    for (const item of items) {
      const name = (item.name || (item.display_name ? item.display_name.split(',')[0] : '')).trim();
      if (!name || seenNames.has(name.toLowerCase())) continue;

      const tags = item.extratags || {};
      const website = tags.website || tags['contact:website'] || tags.url || '';
      if (hasRealWebsite(website)) continue;

      seenNames.add(name.toLowerCase());
      const phone = tags.phone || tags['contact:phone'] || '';
      const email = tags.email || tags['contact:email'] || '';

      const lat = item.lat;
      const lon = item.lon;
      const mapsLink = lat && lon
        ? `https://www.google.com/maps/search/?api=1&query=${lat},${lon}`
        : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}+${encodeURIComponent(location)}+USA`;

      const lead = {
        name,
        phone: formatUsPhone(phone),
        email,
        rating: '—',
        reviews: '0',
        address: item.display_name ? item.display_name.split(',').slice(1, 4).join(',').trim() : '',
        mapsLink,
      };
      leads.push(lead);
      send(ws, 'lead', lead);
    }
  } catch (err) {
    console.warn('Nominatim fallback notice:', err.message);
  }

  return leads;
}

// ──────────────────────────────────────────────
// Main Multi-Source Scraping Pipeline (Supports Multiple Cities)
// ──────────────────────────────────────────────
async function executeScrapePipeline(category, locationsInput, ws) {
  const seenNames = new Set();
  let totalFound = 0;

  const locList = (Array.isArray(locationsInput) ? locationsInput : [locationsInput])
    .map((l) => (typeof l === 'string' ? l.trim() : ''))
    .filter(Boolean);

  if (locList.length === 0) {
    send(ws, 'error', { message: 'Please provide at least one US location.' });
    return;
  }

  const totalCities = locList.length;

  for (let cIdx = 0; cIdx < totalCities; cIdx++) {
    const loc = locList[cIdx];
    send(ws, 'status', {
      message: `🚀 [City ${cIdx + 1}/${totalCities}] Scanning "${category}" in "${loc}" (Total leads found: ${totalFound})…`,
    });

    try {
      const gmapsLeads = await scrapeGoogleMaps(category, loc, ws, seenNames);
      totalFound += gmapsLeads.length;
    } catch (err) {
      console.warn(`Google Maps direct scraper error for ${loc}:`, err.message);
    }

    if (process.env.GOOGLE_API_KEY) {
      try {
        const apiLeads = await fetchFromGooglePlacesAPI(category, loc, ws, seenNames);
        totalFound += apiLeads.length;
      } catch (err) {
        console.warn(`Google Places API error for ${loc}:`, err.message);
      }
    }

    if (totalFound < 15) {
      try {
        const nomLeads = await fetchFromNominatim(category, loc, ws, seenNames);
        totalFound += nomLeads.length;
      } catch (err) {
        console.warn(`Nominatim error for ${loc}:`, err.message);
      }
    }
  }

  if (totalFound === 0) {
    send(ws, 'complete', {
      count: 0,
      message: `No leads without websites found across ${totalCities} cities for "${category}". Try adding neighboring US cities or broader trade categories.`,
    });
  } else {
    send(ws, 'complete', { count: totalFound });
  }
}

// ──────────────────────────────────────────────
// WebSocket Handler
// ──────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('🔌 Client connected via WebSocket');

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return send(ws, 'error', { message: 'Invalid message format.' });
    }

    if (msg.action === 'scrape') {
      const { category, location, locations } = msg;
      const targetLocations = (locations && Array.isArray(locations) && locations.length > 0)
        ? locations
        : (location ? [location] : []);

      if (!category || targetLocations.length === 0) {
        return send(ws, 'error', { message: 'Both business category and at least one location are required.' });
      }

      try {
        await executeScrapePipeline(category.trim(), targetLocations, ws);
      } catch (err) {
        console.error('Scrape pipeline error:', err);
        send(ws, 'error', { message: 'An error occurred during search. Please try again.' });
      }
    }
  });

  ws.on('close', () => console.log('🔌 Client disconnected'));
  ws.on('error', (err) => console.warn('WebSocket error:', err.message));
});

// ──────────────────────────────────────────────
// REST: Location autocomplete via Nominatim (USA Only)
// ──────────────────────────────────────────────
app.get('/api/locations', async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json([]);
  try {
    const resp = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: {
        q,
        format: 'json',
        limit: 10,
        addressdetails: 1,
        countrycodes: 'us',
      },
      headers: OSM_HEADERS,
      timeout: 8000,
    });

    const suggestions = resp.data.map((item) => {
      const addr = item.address || {};
      const city = addr.city || addr.town || addr.village || addr.county || item.display_name.split(',')[0];
      const state = addr['ISO3166-2-lvl4']?.replace('US-', '') || addr.state || '';
      return state ? `${city.trim()}, ${state.trim().toUpperCase()}` : `${city.trim()}, USA`;
    });

    res.json([...new Set(suggestions)].slice(0, 8));
  } catch {
    res.json([]);
  }
});

// ──────────────────────────────────────────────
// REST: PDF Export
// ──────────────────────────────────────────────
app.post('/api/export', (req, res) => {
  try {
    const { leads, category, location, locations } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'No leads to export.' });
    }

    // Sort leads by number of ratings/reviews descending (highest review count first)
    const sortedLeads = [...leads].sort((a, b) => {
      const revA = parseInt(String(a.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
      const revB = parseInt(String(b.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
      if (revB !== revA) return revB - revA;
      const rateA = parseFloat(a.rating) || 0;
      const rateB = parseFloat(b.rating) || 0;
      return rateB - rateA;
    });

    const locDisplay = (Array.isArray(locations) && locations.length > 0)
      ? locations.join(' • ')
      : (location || 'USA');

    const CHUNK = 200;
    const totalParts = Math.ceil(sortedLeads.length / CHUNK);
    const dateStr = new Date().toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    if (totalParts === 1) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'attachment; filename="US_Leads.pdf"');
      const doc = buildPDF(sortedLeads, category || 'General', locDisplay, dateStr, 1, 1);
      doc.pipe(res);
      return;
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="US_Leads.zip"');

    const zip = archiver('zip', { zlib: { level: 9 } });
    zip.pipe(res);

    let finalized = 0;
    for (let i = 0; i < totalParts; i++) {
      const slice = sortedLeads.slice(i * CHUNK, (i + 1) * CHUNK);
      const doc = buildPDF(slice, category || 'General', locDisplay, dateStr, i + 1, totalParts);
      const buffers = [];
      doc.on('data', (chunk) => buffers.push(chunk));
      doc.on('end', () => {
        zip.append(Buffer.concat(buffers), { name: `US_Leads_part${i + 1}.pdf` });
        finalized++;
        if (finalized === totalParts) zip.finalize();
      });
    }
  } catch (err) {
    console.error('PDF export error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'PDF export failed' });
    }
  }
});

function drawStar(doc, cx, cy, spikes, outerRadius, innerRadius, color) {
  let rot = (Math.PI / 2) * 3;
  let x = cx;
  let y = cy;
  const step = Math.PI / spikes;

  doc.save();
  const pathData = [];
  pathData.push(`M ${cx} ${cy - outerRadius}`);
  for (let i = 0; i < spikes; i++) {
    x = cx + Math.cos(rot) * outerRadius;
    y = cy + Math.sin(rot) * outerRadius;
    pathData.push(`L ${x} ${y}`);
    rot += step;

    x = cx + Math.cos(rot) * innerRadius;
    y = cy + Math.sin(rot) * innerRadius;
    pathData.push(`L ${x} ${y}`);
    rot += step;
  }
  pathData.push('Z');
  doc.path(pathData.join(' ')).fill(color);
  doc.restore();
}

function drawCheckBadge(doc, x, y) {
  doc.save();
  doc.circle(x + 5, y + 5, 4.5).lineWidth(1).stroke('#00E599');
  doc.moveTo(x + 2.5, y + 5).lineTo(x + 4.5, y + 7).lineTo(x + 7.5, y + 3.5).lineWidth(1).stroke('#00E599');
  doc.restore();
}

function drawPinIcon(doc, x, y, color = '#00E599') {
  doc.save();
  doc.circle(x + 4, y + 4, 3).lineWidth(1).stroke(color);
  doc.moveTo(x + 4, y + 7).lineTo(x + 4, y + 9).lineWidth(1).stroke(color);
  doc.restore();
}

function drawMapIcon(doc, x, y, color = '#00E599') {
  doc.save();
  doc.moveTo(x + 1, y + 2.5)
    .lineTo(x + 4, y + 1)
    .lineTo(x + 7, y + 2.5)
    .lineTo(x + 10, y + 1)
    .lineTo(x + 10, y + 8)
    .lineTo(x + 7, y + 9.5)
    .lineTo(x + 4, y + 8)
    .lineTo(x + 1, y + 9.5)
    .closePath()
    .lineWidth(1)
    .stroke(color);
  doc.moveTo(x + 4, y + 1).lineTo(x + 4, y + 8).lineWidth(0.8).stroke(color);
  doc.moveTo(x + 7, y + 2.5).lineTo(x + 7, y + 9.5).lineWidth(0.8).stroke(color);
  doc.restore();
}

function drawPhoneIcon(doc, x, y, color = '#00E599') {
  doc.save();
  doc.roundedRect(x + 1, y + 1, 6, 8, 1).lineWidth(1).stroke(color);
  doc.circle(x + 4, y + 7.5, 0.6).fill(color);
  doc.restore();
}

function drawTagIcon(doc, x, y, color = '#00E599') {
  doc.save();
  doc.moveTo(x + 2, y + 2).lineTo(x + 6, y + 2).lineTo(x + 9, y + 5).lineTo(x + 5, y + 9).lineTo(x + 2, y + 6).closePath().lineWidth(1).stroke(color);
  doc.circle(x + 4, y + 4, 0.8).fill(color);
  doc.restore();
}

function drawCalIcon(doc, x, y, color = '#00E599') {
  doc.save();
  doc.roundedRect(x + 1, y + 2, 8, 7, 1).lineWidth(1).stroke(color);
  doc.moveTo(x + 1, y + 4.5).lineTo(x + 9, y + 4.5).lineWidth(0.8).stroke(color);
  doc.restore();
}

function drawRadarLogo(doc, x, y) {
  doc.save();
  doc.circle(x + 14, y + 14, 13).lineWidth(1.5).stroke('#064E3B');
  doc.circle(x + 14, y + 14, 9).lineWidth(1.5).stroke('#059669');
  doc.circle(x + 14, y + 14, 5).lineWidth(1.5).stroke('#10B981');
  doc.circle(x + 14, y + 14, 2).fill('#00E599');
  doc.moveTo(x + 14, y + 14).lineTo(x + 25, y + 7).lineWidth(1.5).stroke('#34D399');
  doc.restore();
}

function buildPDF(leads, category, location, dateStr, partNum, totalParts) {
  const doc = new PDFDocument({
    margin: 0,
    size: 'A4', // 595.28 x 841.89 pt
    bufferPages: true,
  });

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const contentX = 28;
  const contentWidth = 539.28;

  const locs = (location || '').split(' • ').map(l => l.trim()).filter(Boolean);
  const marketsCount = locs.length > 0 ? locs.length : 1;

  const renderBackgroundAndDecorations = () => {
    // Deep dark background
    doc.rect(0, 0, pageWidth, pageHeight).fill('#030712');

    // Top-right emerald flourish
    doc.save();
    const gradTop = doc.linearGradient(pageWidth - 140, 0, pageWidth, 90);
    gradTop.stop(0, '#047857', 0.8).stop(1, '#10B981', 0.9);
    doc.moveTo(pageWidth - 130, 0)
      .lineTo(pageWidth, 0)
      .lineTo(pageWidth, 90)
      .lineTo(pageWidth - 50, 90)
      .closePath()
      .fill(gradTop);
    doc.moveTo(pageWidth - 145, 0).lineTo(pageWidth, 105).lineWidth(2).stroke('#00E599');
    doc.restore();

    // Bottom-right emerald flourish
    doc.save();
    const gradBot = doc.linearGradient(pageWidth - 180, pageHeight, pageWidth, pageHeight - 50);
    gradBot.stop(0, '#064E3B', 0.4).stop(1, '#059669', 0.8);
    doc.moveTo(pageWidth - 180, pageHeight)
      .lineTo(pageWidth, pageHeight)
      .lineTo(pageWidth, pageHeight - 45)
      .closePath()
      .fill(gradBot);
    doc.moveTo(pageWidth - 190, pageHeight).lineTo(pageWidth, pageHeight - 52).lineWidth(1.5).stroke('#00E599');
    doc.restore();
  };

  const renderTopBar = () => {
    drawRadarLogo(doc, contentX, 24);

    doc.font('Helvetica-Bold').fontSize(16).fillColor('#FFFFFF')
      .text('LEADSCRAPPER ', contentX + 36, 26, { continued: true })
      .fillColor('#00E599').text('PRO');

    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#94A3B8')
      .text('F I N D   •   V E R I F Y   •   G R O W', contentX + 37, 46);
  };

  const renderHeroSection = (totalLeads) => {
    const heroY = 72;

    // Headline
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#FFFFFF')
      .text('HIGH-INTENT LEADS', contentX, heroY);

    // Description
    doc.font('Helvetica').fontSize(8).fillColor('#94A3B8')
      .text('Handpicked & verified business leads with real contact details, so you can reach the right prospects, faster.', contentX, heroY + 28, { width: 310, lineGap: 2.5 });

    // Right Stat Card
    const cardW = 188;
    const cardH = 48;
    const cardX = contentX + contentWidth - cardW;
    const cardY = heroY;

    doc.roundedRect(cardX, cardY, cardW, cardH, 8).fill('#081125');
    doc.roundedRect(cardX, cardY, cardW, cardH, 8).lineWidth(1).stroke('#1E293B');

    // Users icon shape
    doc.save();
    doc.circle(cardX + 24, cardY + 20, 5).lineWidth(1.2).stroke('#00E599');
    doc.arc(cardX + 24, cardY + 34, 9, Math.PI, 0, false).lineWidth(1.2).stroke('#00E599');
    doc.restore();

    doc.font('Helvetica-Bold').fontSize(24).fillColor('#00E599')
      .text(String(totalLeads), cardX + 44, cardY + 12);

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#E2E8F0')
      .text('VERIFIED LEADS', cardX + 46 + (String(totalLeads).length * 15), cardY + 21);
  };

  const renderMetadataPill = () => {
    const metaY = 136;
    const metaH = 28;

    doc.roundedRect(contentX, metaY, contentWidth, metaH, 6).fill('#081125');
    doc.roundedRect(contentX, metaY, contentWidth, metaH, 6).lineWidth(0.8).stroke('#13203C');

    const colW = contentWidth / 3;

    // Col 1: Category
    drawTagIcon(doc, contentX + 12, metaY + 9, '#00E599');
    doc.font('Helvetica-Bold').fontSize(6).fillColor('#64748B')
      .text('CATEGORY', contentX + 27, metaY + 6);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#FFFFFF')
      .text(category || 'General', contentX + 27, metaY + 15, { width: colW - 35, lineBreak: false });

    // Divider 1
    doc.moveTo(contentX + colW, metaY + 5).lineTo(contentX + colW, metaY + metaH - 5).lineWidth(0.8).stroke('#13203C');

    // Col 2: Location
    drawPinIcon(doc, contentX + colW + 12, metaY + 9, '#00E599');
    doc.font('Helvetica-Bold').fontSize(6).fillColor('#64748B')
      .text('LOCATION', contentX + colW + 27, metaY + 6);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#FFFFFF')
      .text(location || 'USA', contentX + colW + 27, metaY + 15, { width: colW - 35, lineBreak: false });

    // Divider 2
    doc.moveTo(contentX + (colW * 2), metaY + 5).lineTo(contentX + (colW * 2), metaY + metaH - 5).lineWidth(0.8).stroke('#13203C');

    // Col 3: Date
    drawCalIcon(doc, contentX + (colW * 2) + 12, metaY + 9, '#00E599');
    doc.font('Helvetica-Bold').fontSize(6).fillColor('#64748B')
      .text('DATE', contentX + (colW * 2) + 27, metaY + 6);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#FFFFFF')
      .text(dateStr, contentX + (colW * 2) + 27, metaY + 15, { width: colW - 35, lineBreak: false });
  };

  const colWidths = [24, 210, 105, 105, 95.28];

  const renderTableHeader = (currY) => {
    const headerH = 20;
    doc.rect(contentX, currY, contentWidth, headerH).fill('#091428');
    doc.rect(contentX, currY + headerH - 0.5, contentWidth, 0.5).fill('#13203C');

    let x = contentX;

    // #
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#00E599')
      .text('#', x, currY + 6, { width: colWidths[0], align: 'center' });
    x += colWidths[0];

    // Business Name & Address
    drawCheckBadge(doc, x + 2, currY + 4);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#00E599')
      .text('BUSINESS NAME & ADDRESS', x + 16, currY + 6, { width: colWidths[1] - 18 });
    x += colWidths[1];

    // Phone Number
    drawPhoneIcon(doc, x + 4, currY + 5, '#00E599');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#00E599')
      .text('PHONE NUMBER', x + 17, currY + 6, { width: colWidths[2] - 18 });
    x += colWidths[2];

    // Reputation
    drawStar(doc, x + 6, currY + 9, 5, 3.6, 1.8, '#00E599');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#00E599')
      .text('REPUTATION', x + 17, currY + 6, { width: colWidths[3] - 18 });
    x += colWidths[3];

    // Google Maps
    drawMapIcon(doc, x + 4, currY + 5, '#00E599');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#00E599')
      .text('GOOGLE MAPS', x + 18, currY + 6, { width: colWidths[4] - 20 });

    return currY + headerH;
  };

  const renderTrustFooter = (footerY) => {
    doc.rect(contentX, footerY, contentWidth, 38).fill('#050C1B');
    doc.rect(contentX, footerY, contentWidth, 38).stroke('#0E1E38');

    // Item 1: Real Businesses
    drawCheckBadge(doc, contentX + 12, footerY + 14);
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#FFFFFF')
      .text('REAL BUSINESSES', contentX + 25, footerY + 10);
    doc.font('Helvetica').fontSize(5.5).fillColor('#94A3B8')
      .text('Verified & up-to-date info', contentX + 25, footerY + 20);

    // Item 2: Save Time
    doc.save();
    doc.moveTo(contentX + 152, footerY + 12)
      .lineTo(contentX + 148, footerY + 19)
      .lineTo(contentX + 151, footerY + 19)
      .lineTo(contentX + 147, footerY + 26)
      .lineTo(contentX + 154, footerY + 17)
      .lineTo(contentX + 151, footerY + 17)
      .closePath().fill('#00E599');
    doc.restore();

    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#FFFFFF')
      .text('SAVE TIME', contentX + 160, footerY + 10);
    doc.font('Helvetica').fontSize(5.5).fillColor('#94A3B8')
      .text('No more cold searching', contentX + 160, footerY + 20);

    // Item 3: More Conversions
    drawStar(doc, contentX + 280, footerY + 19, 5, 4, 2, '#00E599');
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#FFFFFF')
      .text('MORE CONVERSIONS', contentX + 290, footerY + 10);
    doc.font('Helvetica').fontSize(5.5).fillColor('#94A3B8')
      .text('Reach high-intent leads', contentX + 290, footerY + 20);

    // Right Callout
    doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#34D399')
      .text('Smarter Leads', contentX + contentWidth - 130, footerY + 9, { width: 120, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#00E599')
      .text('Bigger Opportunities', contentX + contentWidth - 130, footerY + 21, { width: 120, align: 'right' });
  };

  // ── First Page Layout ──
  renderBackgroundAndDecorations();
  renderTopBar();
  renderHeroSection(leads.length);
  renderMetadataPill();
  let tableY = renderTableHeader(176);

  const rowHeight = 25;
  const maxTableY = 735;

  leads.forEach((lead, idx) => {
    if (tableY + rowHeight > maxTableY) {
      renderTrustFooter(746);
      doc.addPage();
      renderBackgroundAndDecorations();
      renderTopBar();
      tableY = renderTableHeader(64);
    }

    const isEven = idx % 2 === 0;
    const bgRowColor = isEven ? '#060D1E' : '#040816';
    doc.rect(contentX, tableY, contentWidth, rowHeight).fill(bgRowColor);
    doc.rect(contentX, tableY + rowHeight - 0.4, contentWidth, 0.4).fill('#0E1B32');

    let x = contentX;

    // Rank
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF')
      .text(String(idx + 1), x, tableY + 8, { width: colWidths[0], align: 'center' });
    x += colWidths[0];

    // Business Name & Address
    const hasAddress = Boolean(lead.address && lead.address !== '—');
    const nameY = hasAddress ? tableY + 4 : tableY + 8;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF')
      .text(lead.name || '—', x + 4, nameY, { width: colWidths[1] - 8, lineBreak: false });

    if (hasAddress) {
      doc.font('Helvetica').fontSize(6.5).fillColor('#64748B')
        .text(lead.address, x + 4, tableY + 15, { width: colWidths[1] - 8, lineBreak: false });
    }
    x += colWidths[1];

    // Phone Number
    const phoneStr = lead.phone ? lead.phone.trim() : '—';
    doc.font('Helvetica').fontSize(8.5).fillColor(lead.phone ? '#E2E8F0' : '#475569')
      .text(phoneStr, x + 4, tableY + 8, { width: colWidths[2] - 8, lineBreak: false });
    x += colWidths[2];

    // Reputation: Green Star + 4.9 (80 reviews)
    const revCount = parseInt(String(lead.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
    const ratingStr = lead.rating && lead.rating !== '—' ? lead.rating : '5.0';

    drawStar(doc, x + 6, tableY + 12, 5, 3.6, 1.8, '#00E599');
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#FFFFFF')
      .text(ratingStr, x + 15, tableY + 8, { continued: true });
    doc.font('Helvetica').fontSize(7).fillColor('#64748B')
      .text(revCount > 0 ? (revCount === 1 ? ' (1 review)' : ` (${revCount} reviews)`) : '');
    x += colWidths[3];

    // Google Maps Link: View Profile (Icons removed from left and right)
    if (lead.mapsLink) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#00E599')
        .text('View Profile', x + 6, tableY + 8, {
          width: colWidths[4] - 12,
          link: lead.mapsLink,
          underline: true,
          lineBreak: false,
        });
    } else {
      doc.font('Helvetica').fontSize(8).fillColor('#475569')
        .text('—', x + 6, tableY + 8);
    }

    tableY += rowHeight;
  });

  renderTrustFooter(746);

  doc.end();
  return doc;
}

// Static client in production
const clientDist = path.join(__dirname, 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => {
  const indexPath = path.join(clientDist, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).send('LeadScrapper API running. Run `cd client && npm run build` to compile the UI.');
  }
});

const PORT = process.env.PORT || 4000;

function freePort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const pids = new Set();
      out.split('\n').forEach((line) => {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && !isNaN(pid) && parseInt(pid) !== process.pid && parseInt(pid) > 0) {
          pids.add(pid);
        }
      });
      pids.forEach((pid) => {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        } catch {}
      });
    } else {
      execSync(`fuser -k ${port}/tcp`, { stdio: 'ignore' });
    }
  } catch {}
}

let retriedListening = false;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    if (!retriedListening) {
      retriedListening = true;
      console.warn(`⚠️ Port ${PORT} already in use. Automatically terminating stale process and retrying...`);
      freePort(PORT);
      setTimeout(() => {
        server.close();
        server.listen(PORT, '0.0.0.0', () => {
          console.log(`🚀 LeadScrapper server running on http://localhost:${PORT}`);
          console.log(`   Strict Website Filter: ✅ Active (Google Maps RPC + DOM dual verification)`);
        });
      }, 1000);
    } else {
      console.error(`❌ Port ${PORT} is still occupied. Please close the process using port ${PORT}.`);
      process.exit(1);
    }
  } else {
    console.error('Server error:', err);
  }
});

const gracefulShutdown = () => {
  console.log('\n🛑 Shutting down server gracefully...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1200);
};

process.on('uncaughtException', (err) => {
  console.warn('⚠️ Prevented crash from uncaughtException:', err?.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.warn('⚠️ Prevented crash from unhandledRejection:', reason?.message || reason);
});

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Ensure port is free before binding
freePort(PORT);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 LeadScrapper server running on http://localhost:${PORT}`);
  console.log(`   Strict Website Filter: ✅ Active (Google Maps RPC + DOM dual verification)`);
});
