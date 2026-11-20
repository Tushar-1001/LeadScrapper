import { useState, useRef, useCallback, useMemo } from 'react';
import axios from 'axios';
import Autocomplete from './components/Autocomplete.jsx';
import MultiCitySelect from './components/MultiCitySelect.jsx';
import LeadTable from './components/LeadTable.jsx';
import StatusBar from './components/StatusBar.jsx';
import ColdPitchModal from './components/ColdPitchModal.jsx';
import {
  BuildingIcon,
  SearchIcon,
  SparklesIcon,
  ShieldCheckIcon,
  RadarIcon,
  CheckIcon,
  PlusIcon,
  FlameIcon,
  BoltIcon,
  PhoneIcon,
  UsersIcon,
  DownloadIcon,
} from './components/Icons.jsx';
import {
  categories,
  cities,
  popularCategories,
  popularCities,
} from './data/datasets.js';

/**
 * Fetch location suggestions from Nominatim (restricted to USA).
 */
async function fetchLocationSuggestions(query) {
  if (!query || query.length < 2) return [];
  try {
    const res = await axios.get('/api/locations', { params: { q: query } });
    return res.data || [];
  } catch {
    return [];
  }
}

export default function App() {
  // ── Form State ──
  const [category, setCategory] = useState('');
  const [selectedCities, setSelectedCities] = useState([]);
  const [errors, setErrors] = useState({});

  // ── Scraping State ──
  const [leads, setLeads] = useState([]);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [scanDuration, setScanDuration] = useState(null);
  const [elapsedTime, setElapsedTime] = useState('0.0');
  const wsRef = useRef(null);
  const timerRef = useRef(null);
  const startTimeRef = useRef(null);

  // ── Results Filter & Search State ──
  const [activeFilter, setActiveFilter] = useState('all'); // 'all' | 'hot' | 'warm' | 'phone'
  const [searchQuery, setSearchQuery] = useState('');
  const [pitchModalLead, setPitchModalLead] = useState(null);
  const [isExportingPDF, setIsExportingPDF] = useState(false);

  // ── Validation ──
  const validate = () => {
    const errs = {};
    if (!category.trim()) errs.category = 'Please enter or select a business category';
    if (!selectedCities || selectedCities.length === 0) {
      errs.location = 'Please select at least one US city or metro';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  // ── Quick chip handlers ──
  const handleSelectCategoryChip = (cat) => {
    setCategory(cat);
    if (errors.category) {
      setErrors((prev) => ({ ...prev, category: undefined }));
    }
  };

  const handleToggleCityChip = (cityName) => {
    if (selectedCities.includes(cityName)) {
      setSelectedCities(selectedCities.filter((c) => c !== cityName));
    } else {
      setSelectedCities([...selectedCities, cityName]);
      if (errors.location) {
        setErrors((prev) => ({ ...prev, location: undefined }));
      }
    }
  };

  // ── Start Scraping via WebSocket ──
  const handleSubmit = useCallback(
    (e) => {
      e?.preventDefault();
      if (!validate()) return;

      // Reset results state & start elapsed timer
      setLeads([]);
      setCount(0);
      setStatus('');
      setIsDone(false);
      setIsLoading(true);
      setActiveFilter('all');
      setSearchQuery('');
      setScanDuration(null);
      setElapsedTime('0.0');

      if (timerRef.current) clearInterval(timerRef.current);
      const startTimestamp = Date.now();
      startTimeRef.current = startTimestamp;
      timerRef.current = setInterval(() => {
        if (startTimeRef.current) {
          const sec = ((Date.now() - startTimeRef.current) / 1000).toFixed(1);
          setElapsedTime(sec);
        }
      }, 100);

      if (wsRef.current) {
        wsRef.current.close();
      }

      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const wsHost =
        window.location.port === '5173'
          ? `${window.location.hostname}:4000`
          : window.location.host;
      const ws = new WebSocket(`${protocol}://${wsHost}`);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            action: 'scrape',
            category: category.trim(),
            locations: selectedCities,
          })
        );
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        switch (msg.event) {
          case 'lead':
            setLeads((prev) => [...prev, msg.data]);
            setCount((c) => c + 1);
            break;
          case 'status':
            setStatus(msg.data.message);
            break;
          case 'complete': {
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
            const finalSec = startTimeRef.current
              ? ((Date.now() - startTimeRef.current) / 1000).toFixed(1)
              : '0.0';
            setScanDuration(finalSec);
            setElapsedTime(finalSec);
            setIsLoading(false);
            setIsDone(true);
            if (msg.data.count === 0) {
              setStatus(
                `Completed in ${finalSec}s. No leads without websites found for this query in the USA. Try adding nearby cities.`
              );
            } else {
              setStatus(`✅ Complete in ${finalSec}s! Found ${msg.data.count} high-intent business leads without websites.`);
            }
            ws.close();
            break;
          }
          case 'error': {
            if (timerRef.current) {
              clearInterval(timerRef.current);
              timerRef.current = null;
            }
            setIsLoading(false);
            setStatus(`❌ ${msg.data.message}`);
            ws.close();
            break;
          }
          default:
            break;
        }
      };

      ws.onerror = () => {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        setIsLoading(false);
        setStatus('❌ Connection error. Please ensure the backend server is running on port 4000.');
      };

      ws.onclose = () => {
        wsRef.current = null;
      };
    },
    [category, selectedCities]
  );

  // ── Leads sorted by number of ratings/reviews descending ──
  const sortedLeads = useMemo(() => {
    return [...leads].sort((a, b) => {
      const revA = parseInt(String(a.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
      const revB = parseInt(String(b.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
      if (revB !== revA) return revB - revA;
      const rateA = parseFloat(a.rating) || 0;
      const rateB = parseFloat(b.rating) || 0;
      return rateB - rateA;
    });
  }, [leads]);

  // ── Computed Bento Metrics ──
  const bentoMetrics = useMemo(() => {
    const total = sortedLeads.length;
    if (total === 0) {
      return {
        total: 0,
        highestReview: { count: 0, rating: '0.0' },
        phoneRate: '0%',
        phoneCount: 0,
        hotCount: 0,
        warmCount: 0,
      };
    }

    const firstLead = sortedLeads[0];
    const topReviews = parseInt(String(firstLead?.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
    const topRating = firstLead?.rating || '5.0';

    const withPhone = sortedLeads.filter((l) => l.phone && l.phone.trim().length > 3).length;
    const phoneRate = ((withPhone / total) * 100).toFixed(1) + '%';

    const hotCount = sortedLeads.filter((l) => {
      const rev = parseInt(String(l.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
      return rev >= 50;
    }).length;

    const warmCount = sortedLeads.filter((l) => {
      const rev = parseInt(String(l.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
      return rev >= 10 && rev < 50;
    }).length;

    return {
      total,
      highestReview: { count: topReviews, rating: topRating },
      phoneRate,
      phoneCount: withPhone,
      hotCount,
      warmCount,
    };
  }, [sortedLeads]);

  // ── Filtered Leads based on activeFilter & search within results ──
  const filteredLeads = useMemo(() => {
    let result = sortedLeads;

    // Apply categorical intent filter
    if (activeFilter === 'hot') {
      result = result.filter((l) => {
        const rev = parseInt(String(l.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
        return rev >= 50;
      });
    } else if (activeFilter === 'warm') {
      result = result.filter((l) => {
        const rev = parseInt(String(l.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
        return rev >= 10 && rev < 50;
      });
    } else if (activeFilter === 'phone') {
      result = result.filter((l) => l.phone && l.phone.trim().length > 3);
    }

    // Apply text search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(
        (l) =>
          l.name?.toLowerCase().includes(q) ||
          l.address?.toLowerCase().includes(q) ||
          l.phone?.includes(q)
      );
    }

    return result;
  }, [sortedLeads, activeFilter, searchQuery]);

  // ── Export Handlers ──
  const handleExportPDF = async () => {
    if (sortedLeads.length === 0) return;
    setIsExportingPDF(true);
    try {
      const res = await axios.post(
        '/api/export',
        {
          leads: sortedLeads,
          category,
          locations: selectedCities,
          location: selectedCities.join(', '),
        },
        { responseType: 'blob' }
      );

      const contentType = res.headers['content-type'] || '';
      if (contentType.includes('application/json')) {
        const text = await res.data.text();
        const errObj = JSON.parse(text);
        throw new Error(errObj.error || 'Server error generating PDF');
      }

      const isPdf = contentType.includes('pdf');
      const fileName = isPdf ? `US_Leads_${category.replace(/\s+/g, '_')}.pdf` : 'US_Leads.zip';

      const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => window.URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.error('PDF Export error:', err);
      alert(`PDF Export failed: ${err.message || 'Please check backend server'}`);
    } finally {
      setIsExportingPDF(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#070A12] text-slate-200">
      {/* ────────── TOP NAVIGATION BAR ────────── */}
      <header className="sticky top-0 z-40 border-b border-white/5 bg-[#070A12]/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          {/* Logo & Version */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-500 via-indigo-600 to-violet-500 p-[1px] shadow-lg shadow-indigo-500/25">
              <div className="w-full h-full bg-surface-900 rounded-[11px] flex items-center justify-center">
                <BoltIcon className="w-5 h-5 text-indigo-400" />
              </div>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-extrabold tracking-tight text-white">
                Lead<span className="bg-gradient-to-r from-indigo-400 to-violet-400 bg-clip-text text-transparent">Scrapper</span>
              </span>
              <span className="px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/25 font-mono">
                PRO v2.4
              </span>
            </div>
            <span className="hidden md:inline-block text-xs text-slate-500 pl-2 border-l border-white/10 font-medium">
              US Small Business Intelligence
            </span>
          </div>

          {/* Engine Status Pill */}
          <div className="hidden sm:flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-xs font-medium text-emerald-400">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span>Google Maps RPC Engine • Ready</span>
          </div>

          {/* Target Region Badge */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-xs text-slate-400 bg-surface-850 px-3 py-1.5 rounded-xl border border-white/5">
              <span className="text-slate-500 hidden sm:inline">Target:</span>
              <span className="text-white font-semibold flex items-center gap-1">
                🇺🇸 USA Metros
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* ────────── MAIN CONTENT AREA ────────── */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-8 space-y-7">

        {/* ── SEARCH & DISCOVERY COMMAND CENTER ── */}
        <section className="glass-panel rounded-2xl p-6 sm:p-7 relative shadow-2xl">
          <div className="absolute -top-24 -right-24 w-96 h-96 bg-indigo-500/10 rounded-full blur-3xl pointer-events-none"></div>

          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 pb-5 border-b border-white/5">
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2.5">
                <span>Find High-Ticket Clients Without Websites</span>
                <span className="text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 rounded-full">
                  100% Dual-Layer Verified
                </span>
              </h1>
              <p className="text-sm text-slate-400 mt-1">
                Select high-value US niches and cities. Every lead is verified via internal RPC + DOM checks to have no active website.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400 bg-white/5 px-2.5 py-1 rounded-md border border-white/5 font-mono">
                140+ Niches
              </span>
              <span className="text-xs text-slate-400 bg-white/5 px-2.5 py-1 rounded-md border border-white/5 font-mono">
                250+ Metros
              </span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Category Field */}
              <div className="lg:col-span-5 space-y-2 relative z-30">
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center justify-between">
                  <span>1. Business Category</span>
                  <span className="text-[11px] text-slate-500 font-normal">e.g. Plumber, Roofing, HVAC</span>
                </label>
                <Autocomplete
                  suggestions={categories}
                  value={category}
                  onChange={(val) => {
                    setCategory(val);
                    if (errors.category) {
                      setErrors((prev) => ({ ...prev, category: undefined }));
                    }
                  }}
                  placeholder="e.g. Roofing Contractor, HVAC, Landscaper…"
                  error={errors.category}
                  icon={BuildingIcon}
                />

                {/* Category Quick Picks (Equal Size Boxes) */}
                <div className="flex items-center gap-2 pt-1 text-[11px]">
                  <span className="text-slate-500 shrink-0 font-medium">Quick:</span>
                  <div className="grid grid-cols-5 gap-1.5 flex-1">
                    {popularCategories.slice(0, 5).map((cat) => {
                      const isSelected = category.toLowerCase() === cat.toLowerCase();
                      return (
                        <button
                          type="button"
                          key={cat}
                          onClick={() => handleSelectCategoryChip(cat)}
                          title={cat}
                          className={`w-full py-1 px-1 rounded-md font-medium text-center truncate transition text-[11px] ${
                            isSelected
                              ? 'bg-indigo-500/25 text-indigo-300 border border-indigo-500/40 shadow-sm'
                              : 'bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white border border-white/5'
                          }`}
                        >
                          {cat}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Target Metros Multi-Select */}
              <div className="lg:col-span-5 space-y-2 relative z-20">
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider flex items-center justify-between">
                  <span>2. Target US Metros</span>
                  {selectedCities.length > 0 && (
                    <span className="text-[11px] text-indigo-400 font-medium">
                      {selectedCities.length} Selected
                    </span>
                  )}
                </label>
                <MultiCitySelect
                  selectedCities={selectedCities}
                  onChange={(citiesList) => {
                    setSelectedCities(citiesList);
                    if (errors.location) {
                      setErrors((prev) => ({ ...prev, location: undefined }));
                    }
                  }}
                  suggestions={cities}
                  fetchSuggestions={fetchLocationSuggestions}
                  placeholder="Search & add US cities (e.g. Dallas, TX)…"
                  error={errors.location}
                />

                {/* Metros Quick Picks (Equal Size Boxes) */}
                <div className="flex items-center gap-2 pt-1 text-[11px]">
                  <span className="text-slate-500 shrink-0 font-medium">Metros:</span>
                  <div className="grid grid-cols-5 gap-1.5 flex-1">
                    {popularCities.slice(0, 5).map((city) => {
                      const isSelected = selectedCities.includes(city);
                      const cityName = city.split(',')[0];
                      return (
                        <button
                          type="button"
                          key={city}
                          onClick={() => handleToggleCityChip(city)}
                          title={city}
                          className={`w-full py-1 px-1 rounded-md font-medium text-center truncate transition text-[11px] ${
                            isSelected
                              ? 'bg-indigo-500/25 text-indigo-300 border border-indigo-500/40 shadow-sm'
                              : 'bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white border border-white/5'
                          }`}
                        >
                          {isSelected ? `✓ ${cityName}` : `+ ${cityName}`}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Launch Action */}
              <div className="lg:col-span-2 flex flex-col justify-end relative z-10">
                <button
                  type="submit"
                  disabled={isLoading}
                  className={`glow-button w-full h-[46px] rounded-xl text-white font-bold text-sm tracking-wide flex items-center justify-center gap-2 transition ${isLoading ? 'opacity-60 cursor-not-allowed' : 'active:scale-95'
                    }`}
                >
                  {isLoading ? (
                    <span className="inline-flex items-center justify-center gap-2">
                      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Scanning… ({elapsedTime}s)
                    </span>
                  ) : (
                    <span className="inline-flex items-center justify-center gap-2">
                      <SearchIcon className="w-4 h-4 text-indigo-200" />
                      <span>Scan Leads</span>
                    </span>
                  )}
                </button>
              </div>
            </div>

            {/* Verification Guarantee Footer note */}
            <div className="pt-2 flex items-center gap-2 text-xs text-slate-500">
              <ShieldCheckIcon className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>Dual-layer filter rejects any business with a domain, website button, or booking portal link.</span>
            </div>
          </form>
        </section>

        {/* ── STATUS BAR ── */}
        <StatusBar
          status={status}
          isLoading={isLoading}
          elapsedTime={elapsedTime}
          scanDuration={scanDuration}
        />

        {/* ── LIVE BENTO METRIC STATS ── */}
        {(count > 0 || isDone) && (
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 animate-fadeIn">
            {/* Bento Card 1: Leads Found */}
            <div className="glass-panel-interactive rounded-2xl p-5 relative overflow-hidden">
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
                <span>High-Intent Leads</span>
                {scanDuration ? (
                  <span className="text-[10px] font-mono font-bold text-emerald-300 bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 rounded-full flex items-center gap-1">
                    ⚡ {scanDuration}s
                  </span>
                ) : (
                  <span className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400">
                    <UsersIcon className="w-4 h-4" />
                  </span>
                )}
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl font-extrabold text-white">{bentoMetrics.total}</span>
                <span className="text-xs font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                  100% No Site
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2 flex items-center justify-between">
                <span>Zero active websites</span>
                {scanDuration && (
                  <span className="text-indigo-300 font-mono font-semibold">
                    Completed in {scanDuration}s
                  </span>
                )}
              </p>
            </div>

            {/* Bento Card 2: Highest Reviews */}
            <div className="glass-panel-interactive rounded-2xl p-5 relative overflow-hidden">
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
                <span>Top Reputation Lead</span>
                <span className="p-1.5 rounded-lg bg-amber-500/10 text-amber-400">
                  <FlameIcon className="w-4 h-4" />
                </span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl font-extrabold text-amber-400">
                  {bentoMetrics.highestReview.count}
                </span>
                <span className="text-xs text-slate-400">
                  Reviews ({bentoMetrics.highestReview.rating} ★)
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2">Prime candidate for website redesign pitch</p>
            </div>

            {/* Bento Card 3: Phone Direct Contact Rate */}
            <div className="glass-panel-interactive rounded-2xl p-5 relative overflow-hidden">
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
                <span>Direct Phone Rate</span>
                <span className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-400">
                  <PhoneIcon className="w-4 h-4" />
                </span>
              </div>
              <div className="mt-3 flex items-baseline gap-2">
                <span className="text-3xl font-extrabold text-emerald-400">{bentoMetrics.phoneRate}</span>
                <span className="text-xs text-slate-400">
                  ({bentoMetrics.phoneCount}/{bentoMetrics.total} Available)
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-2">Immediate cold-call readiness</p>
            </div>

            {/* Bento Card 4: Executive PDF Export Hub */}
            <div className="glass-panel-interactive rounded-2xl p-5 flex flex-col justify-between">
              <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
                <span>Executive Export</span>
                <span className="px-2 py-0.5 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-[10px] text-indigo-300 font-mono font-bold">
                  PDF REPORT
                </span>
              </div>

              <div className="mt-3">
                <button
                  type="button"
                  onClick={handleExportPDF}
                  disabled={sortedLeads.length === 0 || isExportingPDF}
                  className="w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white font-semibold text-xs flex items-center justify-center gap-2 transition shadow-lg shadow-indigo-950/50 border border-indigo-400/30 disabled:opacity-40 disabled:cursor-not-allowed group"
                >
                  <DownloadIcon className="w-4 h-4 text-indigo-100 group-hover:scale-110 transition-transform" />
                  <span className="tracking-wide">
                    {isExportingPDF ? 'Generating Document…' : 'Export PDF Report'}
                  </span>
                </button>
              </div>

              <p className="text-[11px] text-slate-400 mt-2">Verified zero-website intelligence report ready for outreach</p>
            </div>
          </section>
        )}

        {/* ── SMART FILTER & TOOLBAR ── */}
        {(count > 0 || isDone) && sortedLeads.length > 0 && (
          <section className="glass-panel rounded-2xl p-4 flex flex-wrap items-center justify-between gap-4 animate-fadeIn">
            {/* Filter Pills */}
            <div className="flex items-center gap-2 overflow-x-auto text-xs">
              <span className="text-slate-500 font-semibold uppercase tracking-wider text-[11px] mr-1">
                Filter:
              </span>
              <button
                type="button"
                onClick={() => setActiveFilter('all')}
                className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 transition ${activeFilter === 'all'
                  ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                  : 'bg-surface-900 text-slate-400 hover:text-white border border-white/5'
                  }`}
              >
                <span>All Leads</span>
                <span className="bg-indigo-500/30 text-[10px] px-1.5 py-0.2 rounded-full font-mono">
                  {bentoMetrics.total}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFilter('hot')}
                className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 transition ${activeFilter === 'hot'
                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                  : 'bg-surface-900 text-slate-400 hover:text-white border border-white/5'
                  }`}
              >
                <span className="text-amber-400">🔥 Hot Leads (50+ Reviews)</span>
                <span className="bg-white/5 text-[10px] px-1.5 py-0.2 rounded-full font-mono">
                  {bentoMetrics.hotCount}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFilter('warm')}
                className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 transition ${activeFilter === 'warm'
                  ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                  : 'bg-surface-900 text-slate-400 hover:text-white border border-white/5'
                  }`}
              >
                <span className="text-blue-400">⚡ Warm (10-49)</span>
                <span className="bg-white/5 text-[10px] px-1.5 py-0.2 rounded-full font-mono">
                  {bentoMetrics.warmCount}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFilter('phone')}
                className={`px-3 py-1.5 rounded-lg font-semibold flex items-center gap-1.5 transition ${activeFilter === 'phone'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                  : 'bg-surface-900 text-slate-400 hover:text-white border border-white/5'
                  }`}
              >
                <span>📞 Has Phone Only</span>
                <span className="bg-white/5 text-[10px] px-1.5 py-0.2 rounded-full font-mono">
                  {bentoMetrics.phoneCount}
                </span>
              </button>
            </div>

            {/* In-Results Search Input */}
            <div className="flex items-center gap-2">
              <div className="relative">
                <SearchIcon className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search within leads…"
                  className="bg-surface-900 border border-white/10 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 w-44 sm:w-52 font-medium"
                />
              </div>
              <div className="text-xs text-slate-400 bg-surface-900 border border-white/10 rounded-lg px-2.5 py-1.5 font-medium flex items-center gap-1">
                <span className="text-indigo-400">Sorted:</span> Most Reviews ↓
              </div>
            </div>
          </section>
        )}

        {/* ── HIGH-VALUE LEADS TABLE ── */}
        <LeadTable
          leads={filteredLeads}
          onOpenPitch={(lead) => setPitchModalLead(lead)}
          scanDuration={scanDuration}
        />

        {/* Empty Search Results within Filter */}
        {sortedLeads.length > 0 && filteredLeads.length === 0 && (
          <div className="glass-panel border border-white/10 rounded-2xl p-10 text-center max-w-md mx-auto">
            <p className="text-sm text-slate-400">
              No leads match your current filter (<span className="text-white font-semibold">{activeFilter}</span>) or search query.
            </p>
            <button
              type="button"
              onClick={() => {
                setActiveFilter('all');
                setSearchQuery('');
              }}
              className="mt-3 px-3.5 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold"
            >
              Reset Filters
            </button>
          </div>
        )}

        {/* Empty State: Zero Leads Found after full run */}
        {isDone && count === 0 && (
          <div className="glass-panel border border-white/10 rounded-3xl p-12 text-center max-w-lg mx-auto shadow-2xl">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <RadarIcon className="w-7 h-7" />
            </div>
            <h3 className="text-lg font-bold text-white mb-1">No Leads Without Websites Found</h3>
            <p className="text-sm text-slate-400 mb-4 leading-relaxed">
              All businesses found for this specific query already have an active website. Try adding multiple neighboring metros or testing high-demand niches like Roofing, Locksmith, Tree Service, or Concrete.
            </p>
          </div>
        )}
      </main>

      {/* ────────── AI COLD OUTREACH MODAL ────────── */}
      {pitchModalLead && (
        <ColdPitchModal
          lead={pitchModalLead}
          onClose={() => setPitchModalLead(null)}
        />
      )}

      {/* ────────── FOOTER ────────── */}
      <footer className="mt-auto py-6 border-t border-white/5 bg-[#070A12] text-center text-xs text-slate-500">
        LeadScrapper Pro • Dual-Layer Verified Small Business Outreach • {new Date().getFullYear()}
      </footer>
    </div>
  );
}
