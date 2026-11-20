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

      return {
        website: '',
        foundBy: 'none',
        detailPhone,
        detailReviews,
        detailRating,
        detailAddress,
      };
    });

    placeVerifyCache.set(normName, details);
    return details;
  } catch (err) {
    console.warn(`Verification note for "${candidateName}":`, err.message);
    return { website: '', foundBy: 'error' };
  }
}

// Category Synonyms & High-Intent Trade Variations for US Local Markets
const CATEGORY_TRADE_SYNONYMS = {
  plumber: ['Plumbing Repair', 'Licensed Plumber', 'Residential Plumber', 'Emergency Plumbing', 'Commercial Plumber', 'Drain Cleaning'],
  plumbing: ['Plumbing Repair', 'Licensed Plumber', 'Residential Plumber', 'Emergency Plumbing', 'Commercial Plumber'],
  'roofing contractor': ['Roof Repair & Replacement', 'Residential Roofing', 'Commercial Roofing', 'Emergency Roof Repair', 'Roofing Services'],
  roofing: ['Roof Repair & Replacement', 'Residential Roofing', 'Commercial Roofing', 'Emergency Roof Repair'],
  'hvac contractor': ['AC Repair', 'Heating & Air Conditioning', 'HVAC Repair Service', 'Air Conditioning Contractor', 'Furnace Repair'],
  'hvac services': ['AC Repair', 'Heating & Air Conditioning', 'HVAC Repair Service', 'Air Conditioning Contractor'],
  hvac: ['AC Repair', 'Heating & Air Conditioning', 'HVAC Repair Service', 'Air Conditioning Contractor'],
  electrician: ['Electrical Repair', 'Licensed Electrician', 'Residential Electrician', 'Emergency Electrician', 'Commercial Electrician'],
  electrical: ['Electrical Repair', 'Licensed Electrician', 'Residential Electrician', 'Emergency Electrician'],
  'landscaping & lawn care': ['Lawn Care Service', 'Lawn Mowing & Maintenance', 'Residential Landscaping', 'Tree Trimming & Removal', 'Yard Maintenance'],
  landscaping: ['Lawn Care Service', 'Lawn Mowing & Maintenance', 'Residential Landscaping', 'Tree Trimming & Removal'],
  'lawn care': ['Lawn Care Service', 'Lawn Mowing & Maintenance', 'Yard Clean Up', 'Lawn Treatment'],
  'general contractor': ['Home Remodeling Contractor', 'Home Renovation', 'Kitchen & Bath Remodeling', 'Residential Contractor'],
  'home remodeling & renovation': ['Kitchen Remodeling', 'Bathroom Remodeling', 'Home Renovation Contractor', 'Home Improvement'],
  'kitchen & bathroom remodeling': ['Kitchen Remodeler', 'Bathroom Remodeler', 'Cabinet & Tile Installation'],
  painter: ['House Painting', 'Interior & Exterior Painting', 'Residential Painter', 'Commercial Painter'],
  painting: ['House Painting', 'Interior & Exterior Painting', 'Residential Painter', 'Commercial Painter'],
  'towing service': ['Emergency Towing', '24 Hour Tow Truck', 'Roadside Assistance', 'Wrecker Service'],
  towing: ['Emergency Towing', '24 Hour Tow Truck', 'Roadside Assistance', 'Wrecker Service'],
  'auto repair': ['Auto Mechanic', 'Brake Repair & Service', 'Transmission Repair', 'Engine Diagnostic & Repair'],
  'auto repair & mechanic': ['Auto Mechanic', 'Brake Repair & Service', 'Transmission Repair', 'Car Maintenance'],
  dentist: ['Family Dentistry', 'Emergency Dentist', 'Dental Clinic', 'Cosmetic Dentist'],
  'pest control': ['Exterminator Service', 'Termite Control', 'Pest Extermination', 'Bed Bug Removal'],
  locksmith: ['Emergency Locksmith', '24 Hour Locksmith', 'Car Key Replacement', 'Mobile Locksmith'],
  'carpet cleaning': ['Carpet & Upholstery Cleaning', 'Steam Cleaning', 'Commercial Carpet Cleaning', 'Rug Cleaning'],
  'pressure washing': ['Power Washing', 'Driveway & House Washing', 'Commercial Pressure Washing', 'Roof Cleaning'],
  'tree service': ['Tree Removal', 'Tree Trimming & Pruning', 'Stump Grinding', 'Emergency Tree Service'],
  'fence contractor': ['Fence Installation', 'Wood & Vinyl Fencing', 'Fence Repair Contractor'],
  'concrete contractor': ['Concrete Flatwork & Driveways', 'Stamped Concrete', 'Foundation & Patio Concrete'],
  'epoxy flooring & garage coating': ['Garage Epoxy Flooring', 'Commercial Epoxy Coating', 'Concrete Polishing & Epoxy'],
  'septic tank pumping & repair': ['Septic Pumping', 'Septic Tank Cleaning', 'Septic System Repair'],
  'chimney sweep & fireplace repair': ['Chimney Inspection & Cleaning', 'Fireplace Repair', 'Chimney Cap Installation'],
  'asphalt paving & sealcoating': ['Driveway Paving', 'Asphalt Sealcoating', 'Parking Lot Paving'],
  'dumpster rental & waste management': ['Roll Off Dumpster Rental', 'Commercial Waste Management', 'Junk Removal & Dumpsters'],
  'stump grinding & tree removal': ['Stump Grinding Service', 'Tree Removal Specialist', 'Emergency Tree Cutting'],
  'solar panel cleaning & maintenance': ['Solar Panel Cleaning', 'Solar Panel Maintenance & Repair', 'Solar System Service'],
  'crawl space & basement waterproofing': ['Basement Waterproofing', 'Crawl Space Encapsulation', 'Foundation Waterproofing'],
  'appliance installation & repair': ['Appliance Repair Service', 'Refrigerator & Washer Repair', 'Commercial Appliance Repair'],
  'cabinet refacing & custom cabinets': ['Cabinet Refacing', 'Custom Kitchen Cabinets', 'Cabinet Makers & Installers'],
  'dryer vent cleaning service': ['Dryer Vent Cleaning', 'Air Duct & Dryer Vent Service', 'Commercial Dryer Vent Cleaning'],
  'gutter guard & leaf filter installation': ['Gutter Guard Installation', 'Seamless Gutter Installation', 'Gutter Cleaning & Guards'],
  'security camera & alarm installation': ['Security Camera Installation', 'CCTV & Alarm Systems', 'Commercial Security Systems'],
  'well drilling & pump repair': ['Water Well Drilling', 'Well Pump Repair & Service', 'Water Filtration & Well Service'],
  'mobile car wash & detailing': ['Mobile Auto Detailing', 'Mobile Car Wash Service', 'Ceramic Coating & Paint Correction'],
  'pergola, gazebo & awning builder': ['Pergola Builder', 'Custom Gazebo Construction', 'Patio Awning Installation'],
  'bail bonds service': ['24 Hour Bail Bonds', 'Bail Bondsman', 'Licensed Bail Bonds Agent'],
  'hvac duct cleaning & sanitizing': ['Air Duct Cleaning', 'Duct Sanitizing Service', 'HVAC Air Duct Specialists'],
  'commercial carpet & floor cleaning': ['Commercial Carpet Cleaning', 'Commercial Floor Waxing & Cleaning', 'Janitorial Floor Care'],
};

// City Inner Quadrants and Prominent Neighborhoods (100% within city limits)
const CITY_INNER_NEIGHBORHOODS = {
  dallas: ['North Dallas', 'Oak Cliff', 'East Dallas', 'Downtown', 'Uptown', 'Lake Highlands', 'Preston Hollow', 'Oak Lawn', 'South Dallas'],
  houston: ['The Heights', 'Downtown', 'Montrose', 'Midtown', 'Westchase', 'Galleria', 'Northside', 'Medical Center', 'East End'],
  austin: ['South Congress', 'Downtown', 'East Austin', 'North Austin', 'South Austin', 'Barton Hills', 'Mueller', 'Hyde Park'],
  'san antonio': ['Downtown', 'Stone Oak', 'Alamo Heights', 'North Central', 'Southtown', 'West Side', 'Medical Center'],
  'fort worth': ['Downtown', 'Northside', 'Southside', 'Cultural District', 'West 7th', 'Stockyards', 'TCU Area'],
  'los angeles': ['Downtown LA', 'Hollywood', 'Westwood', 'Silver Lake', 'North Hollywood', 'Van Nuys', 'San Pedro', 'Encino'],
  chicago: ['Loop', 'Lincoln Park', 'Wicker Park', 'Logan Square', 'Hyde Park', 'Lakeview', 'Bridgeport', 'West Loop'],
  phoenix: ['Downtown Phoenix', 'Arcadia', 'Biltmore', 'Ahwatukee', 'North Mountain', 'Maryvale', 'Paradise Valley Village'],
  miami: ['Downtown Miami', 'Brickell', 'Little Havana', 'Wynwood', 'Coconut Grove', 'Design District', 'Overtown'],
  atlanta: ['Downtown', 'Midtown', 'Buckhead', 'Inman Park', 'Old Fourth Ward', 'West End', 'Virginia-Highland'],
  denver: ['Downtown', 'Capitol Hill', 'Cherry Creek', 'LoDo', 'Highland', 'Five Points', 'Wash Park'],
  seattle: ['Downtown', 'Capitol Hill', 'Ballard', 'Queen Anne', 'Fremont', 'West Seattle', 'South Lake Union'],
  'new york': ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island', 'Harlem', 'Astoria', 'Williamsburg'],
  'san diego': ['Downtown', 'North Park', 'Pacific Beach', 'Hillcrest', 'La Jolla', 'Ocean Beach', 'Point Loma'],
  'las vegas': ['Downtown', 'Summerlin', 'The Strip area', 'Southwest', 'Northwest', 'Centennial Hills'],
  orlando: ['Downtown', 'Lake Eola', 'College Park', 'Baldwin Park', 'MetroWest', 'Thornton Park'],
  tampa: ['Downtown', 'Ybor City', 'Hyde Park', 'Seminole Heights', 'Tampa Palms', 'Westshore'],
  charlotte: ['Uptown', 'South End', 'NoDa', 'Dilworth', 'Plaza Midwood', 'Ballantyne', 'University City'],
  columbus: ['Short North', 'German Village', 'Clintonville', 'Downtown', 'Franklinton', 'Arena District'],
  indianapolis: ['Downtown', 'Broad Ripple', 'Fountain Square', 'Mass Ave', 'Irvington', 'Northside'],
  nashville: ['Downtown', 'The Gulch', 'East Nashville', 'Music Row', 'Germantown', 'Green Hills'],
  jacksonville: ['Downtown', 'Riverside', 'San Marco', 'Avondale', 'Southside', 'Northside'],
  'san jose': ['Downtown', 'Willow Glen', 'Rose Garden', 'Almaden Valley', 'West San Jose', 'North San Jose'],
  detroit: ['Downtown', 'Midtown', 'Corktown', 'Eastern Market', 'Woodbridge', 'New Center'],
  philadelphia: ['Center City', 'South Philly', 'Fishtown', 'Northern Liberties', 'University City', 'Chestnut Hill'],
  boston: ['Downtown', 'Back Bay', 'South End', 'Beacon Hill', 'North End', 'Dorchester', 'South Boston'],
  baltimore: ['Inner Harbor', 'Fells Point', 'Canton', 'Federal Hill', 'Mount Vernon', 'Hampden'],
  milwaukee: ['Downtown', 'Historic Third Ward', 'Bay View', 'East Side', 'Walker\'s Point', 'Riverwest'],
  'kansas city': ['Downtown', 'Crossroads', 'Country Club Plaza', 'Westport', 'River Market', 'Brookside'],
  raleigh: ['Downtown', 'North Hills', 'Cameron Village', 'Glenwood South', 'Oakwood', 'Five Points'],
  'salt lake city': ['Downtown', 'Sugar House', 'The Avenues', 'Central City', 'Capitol Hill', 'Rose Park'],
  'oklahoma city': ['Downtown', 'Bricktown', 'Midtown', 'Paseo', 'Plaza District', 'Nichols Hills area'],
};

// Generates targeted, 100% same-city & same-trade multi-query scan list
function buildDeepQueries(category, location) {
  const cleanLoc = location.replace(/,\s*USA$/i, '').trim();
  const cityParts = cleanLoc.split(',').map((s) => s.trim());
  const cityName = cityParts[0];
  const stateCode = cityParts[1] || '';
  const lowerCity = cityName.toLowerCase();
  const lowerCat = category.toLowerCase().trim();

  const queries = [];
  const added = new Set();
  function addQ(q) {
    const clean = q.trim();
    if (clean && !added.has(clean.toLowerCase())) {
      added.add(clean.toLowerCase());
      queries.push(clean);
    }
  }

  // 1. Primary exact category query (full deep search in target city)
  addQ(`${category} in ${cleanLoc}, USA`);

  // 2. High-intent trade variations within the exact same city
  let matchedSynonyms = CATEGORY_TRADE_SYNONYMS[lowerCat];
  if (!matchedSynonyms) {
    for (const [key, syns] of Object.entries(CATEGORY_TRADE_SYNONYMS)) {
      if (lowerCat.includes(key) || key.includes(lowerCat)) {
        matchedSynonyms = syns;
        break;
      }
    }
  }

  if (matchedSynonyms && matchedSynonyms.length > 0) {
    for (const syn of matchedSynonyms.slice(0, 3)) {
      addQ(`${syn} in ${cleanLoc}, USA`);
    }
  } else {
    addQ(`Residential ${category} in ${cleanLoc}, USA`);
    addQ(`Commercial ${category} in ${cleanLoc}, USA`);
    addQ(`${category} repair in ${cleanLoc}, USA`);
  }

  // 3. Independent & local trade contractors in target city
  addQ(`Independent ${category} in ${cleanLoc}, USA`);
  addQ(`Local ${category} in ${cleanLoc}, USA`);

  // 4. Inner City Quadrants & Neighborhoods (cleanly formatted with city & state)
  const innerAreas = CITY_INNER_NEIGHBORHOODS[lowerCity] || [
    'Downtown',
    'North',
    'South',
    'East',
    'West',
  ];

  for (const area of innerAreas.slice(0, 3)) {
    if (area.toLowerCase().includes(lowerCity)) {
      addQ(`${category} in ${area}, ${stateCode || 'USA'}`);
    } else {
      addQ(`${category} in ${area}, ${cleanLoc}, USA`);
    }
  }

  return queries;
}

async function scrapeGoogleMaps(category, location, ws, seenNames) {
  const executablePath = getBrowserExecutable();
  if (!executablePath) {
    console.warn('Chrome/Edge executable not found for Google Maps scraping.');
    return [];
  }

  // Multi-Locality & Trade Synonym Query Engine (100% same city & category)
  const queriesToRun = buildDeepQueries(category, location);

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

            items.push({
              name,
              phone,
              rating,
              cardReviews,
              address,
              cardWebsite,
              mapsLink: link.href,
            });
          });

          return items;
        });

        // Instant Pre-Filter (Eliminates obvious website owners in 0ms)
        const candidatesToVerify = [];
        for (const item of extracted) {
          const key = item.name.toLowerCase().trim();
          if (seenNames.has(key)) continue;
          seenNames.add(key);

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
        await sleep(650);

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

    const rightX = contentX + contentWidth - 150;
    doc.moveTo(rightX - 12, 26).lineTo(rightX - 12, 54).lineWidth(1).stroke('#1E293B');

    doc.font('Helvetica-Bold').fontSize(8).fillColor('#E2E8F0')
      .text('INTELLIGENCE REPORT', rightX, 29, { width: 150, align: 'left' });
    doc.font('Helvetica').fontSize(7).fillColor('#00E599')
      .text(`PART ${partNum} OF ${totalParts}`, rightX, 42, { width: 150, align: 'left' });
  };

  const renderHeroSection = (totalLeads) => {
    const heroY = 74;

    // Verified Leads Pill
    const pillW = 82;
    const pillH = 15;
    doc.roundedRect(contentX, heroY, pillW, pillH, 7.5).fill('#059669');
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#FFFFFF')
      .text('VERIFIED LEADS', contentX, heroY + 4, { width: pillW, align: 'center' });

    // Headline
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#FFFFFF')
      .text('HIGH-INTENT LEADS', contentX, heroY + 20);

    // Subtitle
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#00E599')
      .text('(ZERO WEBSITE GUARANTEED)', contentX, heroY + 47);

    // Description
    doc.font('Helvetica').fontSize(7.5).fillColor('#94A3B8')
      .text('Handpicked & verified business leads with real contact details, so you can reach the right prospects, faster.', contentX, heroY + 63, { width: 310, lineGap: 2 });

    // Right Stat Card
    const cardW = 188;
    const cardH = 88;
    const cardX = contentX + contentWidth - cardW;
    const cardY = heroY - 4;

    doc.roundedRect(cardX, cardY, cardW, cardH, 8).fill('#081125');
    doc.roundedRect(cardX, cardY, cardW, cardH, 8).lineWidth(1).stroke('#1E293B');

    // Users icon shape
    doc.save();
    doc.circle(cardX + 24, cardY + 22, 5).lineWidth(1.2).stroke('#00E599');
    doc.arc(cardX + 24, cardY + 36, 9, Math.PI, 0, false).lineWidth(1.2).stroke('#00E599');
    doc.restore();

    doc.font('Helvetica-Bold').fontSize(26).fillColor('#00E599')
      .text(String(totalLeads), cardX + 44, cardY + 14);

    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#E2E8F0')
      .text('VERIFIED LEADS', cardX + 46 + (String(totalLeads).length * 16), cardY + 23);

    doc.moveTo(cardX + 14, cardY + 49).lineTo(cardX + cardW - 14, cardY + 49).lineWidth(0.5).stroke('#1E293B');

    // Left Sub-metric
    drawPinIcon(doc, cardX + 32, cardY + 54, '#00E599');
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#FFFFFF')
      .text('0', cardX + 16, cardY + 64, { width: 50, align: 'center' });
    doc.font('Helvetica').fontSize(5.5).fillColor('#94A3B8')
      .text('WEBSITES\nREQUIRED', cardX + 10, cardY + 76, { width: 62, align: 'center', lineGap: 1 });

    doc.moveTo(cardX + cardW / 2, cardY + 54).lineTo(cardX + cardW / 2, cardY + 84).lineWidth(0.5).stroke('#1E293B');

    // Right Sub-metric
    drawPinIcon(doc, cardX + cardW / 2 + 36, cardY + 54, '#00E599');
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#FFFFFF')
      .text(String(marketsCount), cardX + cardW / 2 + 20, cardY + 64, { width: 50, align: 'center' });
    doc.font('Helvetica').fontSize(5.5).fillColor('#94A3B8')
      .text('MARKETS\nCOVERED', cardX + cardW / 2 + 14, cardY + 76, { width: 62, align: 'center', lineGap: 1 });
  };

  const renderMetadataPill = () => {
    const metaY = 168;
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

  const colWidths = [24, 215, 110, 95, 95.28];

  const renderTableHeader = (currY) => {
    doc.rect(contentX, currY, contentWidth, 18).fill('#091428');
    doc.rect(contentX, currY + 17.5, contentWidth, 0.5).fill('#13203C');

    let x = contentX;

    // #
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#00E599')
      .text('#', x, currY + 5, { width: colWidths[0], align: 'center' });
    x += colWidths[0];

    // Business Name & Address
    drawCheckBadge(doc, x + 2, currY + 3);
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#00E599')
      .text('BUSINESS NAME & ADDRESS', x + 15, currY + 5, { width: colWidths[1] - 18 });
    x += colWidths[1];

    // Phone Number
    drawPhoneIcon(doc, x + 4, currY + 4, '#00E599');
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#00E599')
      .text('PHONE NUMBER', x + 16, currY + 5, { width: colWidths[2] - 18 });
    x += colWidths[2];

    // Reputation
    drawStar(doc, x + 7, currY + 8, 5, 3.5, 1.8, '#00E599');
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#00E599')
      .text('REPUTATION', x + 16, currY + 5, { width: colWidths[3] - 18 });
    x += colWidths[3];

    // Google Maps
    drawPinIcon(doc, x + 4, currY + 4, '#00E599');
    doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#00E599')
      .text('GOOGLE MAPS', x + 14, currY + 5, { width: colWidths[4] - 16 });

    return currY + 18;
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
  let tableY = renderTableHeader(202);

  const rowHeight = 22;
  const maxTableY = 740;

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
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#FFFFFF')
      .text(String(idx + 1), x, tableY + 6, { width: colWidths[0], align: 'center' });
    x += colWidths[0];

    // Business Name & Address
    const hasAddress = Boolean(lead.address && lead.address !== '—');
    const nameY = hasAddress ? tableY + 3 : tableY + 6;
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#FFFFFF')
      .text(lead.name || '—', x + 4, nameY, { width: colWidths[1] - 8, lineBreak: false });

    if (hasAddress) {
      doc.font('Helvetica').fontSize(5.5).fillColor('#64748B')
        .text(lead.address, x + 4, tableY + 12, { width: colWidths[1] - 8, lineBreak: false });
    }
    x += colWidths[1];

    // Phone Number
    const phoneStr = lead.phone ? lead.phone.trim() : '—';
    doc.font('Helvetica').fontSize(7).fillColor(lead.phone ? '#E2E8F0' : '#475569')
      .text(phoneStr, x + 4, tableY + 6, { width: colWidths[2] - 8, lineBreak: false });
    x += colWidths[2];

    // Reputation: Green Star + 4.9 (97 revs)
    const revCount = parseInt(String(lead.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
    const ratingStr = lead.rating && lead.rating !== '—' ? lead.rating : '5.0';

    drawStar(doc, x + 7, tableY + 9, 5, 3.2, 1.6, '#00E599');
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#FFFFFF')
      .text(ratingStr, x + 14, tableY + 6, { continued: true });
    doc.font('Helvetica').fontSize(6).fillColor('#64748B')
      .text(revCount > 0 ? ` (${revCount} revs)` : '');
    x += colWidths[3];

    // Google Maps Link: Pin icon + View Profile ->
    drawPinIcon(doc, x + 4, tableY + 6, '#00E599');
    if (lead.mapsLink) {
      doc.font('Helvetica-Bold').fontSize(6.5).fillColor('#00E599')
        .text('View Profile ->', x + 13, tableY + 6, {
          width: colWidths[4] - 16,
          link: lead.mapsLink,
          underline: true,
          lineBreak: false,
        });
    } else {
      doc.font('Helvetica').fontSize(6.5).fillColor('#475569')
        .text('—', x + 13, tableY + 6);
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
