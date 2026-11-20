import { useState, useRef, useEffect } from 'react';
import { MapPinIcon, CloseIcon, PlusIcon } from './Icons.jsx';

/**
 * MultiCitySelect — Dark Glassmorphic Tag/Chip input for selecting multiple US cities.
 */
export default function MultiCitySelect({
  selectedCities = [],
  onChange,
  suggestions = [],
  fetchSuggestions,
  placeholder = 'Add US cities (e.g. Dallas, TX)…',
  error,
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [highlighted, setHighlighted] = useState(-1);
  const wrapperRef = useRef(null);
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Filter suggestions based on query
  useEffect(() => {
    if (!query.trim()) {
      const available = suggestions
        .filter((s) => !selectedCities.includes(s))
        .slice(0, 60);
      setItems(available);
      return;
    }

    const lower = query.toLowerCase().trim();
    const localMatches = suggestions.filter(
      (s) => s.toLowerCase().includes(lower) && !selectedCities.includes(s)
    );

    if (fetchSuggestions) {
      clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        try {
          const remote = await fetchSuggestions(query);
          const cleanRemote = (remote || []).filter((r) => !selectedCities.includes(r));
          const merged = [...new Set([...localMatches, ...cleanRemote])];
          setItems(merged.slice(0, 40));
        } catch {
          setItems(localMatches.slice(0, 40));
        }
      }, 250);
    } else {
      setItems(localMatches.slice(0, 40));
    }
  }, [query, suggestions, selectedCities, fetchSuggestions]);

  const addCity = (cityName) => {
    const trimmed = cityName.trim();
    if (!trimmed) return;
    if (!selectedCities.includes(trimmed)) {
      onChange([...selectedCities, trimmed]);
    }
    setQuery('');
    setHighlighted(-1);
    inputRef.current?.focus();
  };

  const removeCity = (cityToRemove) => {
    onChange(selectedCities.filter((c) => c !== cityToRemove));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown' && items.length > 0) {
      e.preventDefault();
      setOpen(true);
      setHighlighted((h) => (h + 1) % items.length);
    } else if (e.key === 'ArrowUp' && items.length > 0) {
      e.preventDefault();
      setOpen(true);
      setHighlighted((h) => (h - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && highlighted >= 0 && items[highlighted]) {
        addCity(items[highlighted]);
      } else if (query.trim()) {
        addCity(query);
      }
    } else if (e.key === 'Backspace' && !query && selectedCities.length > 0) {
      removeCity(selectedCities[selectedCities.length - 1]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div ref={wrapperRef} className="relative group">
      <div
        onClick={() => inputRef.current?.focus()}
        className={`w-full min-h-[46px] bg-surface-900 border rounded-xl p-2 pl-3 flex flex-wrap items-center gap-1.5 transition-all cursor-text shadow-inner ${
          error
            ? 'border-rose-500 ring-1 ring-rose-500/30'
            : open
            ? 'border-indigo-500 ring-1 ring-indigo-500/50'
            : 'border-white/10 hover:border-white/20'
        }`}
      >
        <span className="text-slate-500 group-focus-within:text-indigo-400 transition-colors duration-200 shrink-0">
          <MapPinIcon className="w-4 h-4 text-indigo-400" />
        </span>

        {/* Selected City Chips */}
        {selectedCities.map((city) => (
          <span
            key={city}
            className="inline-flex items-center gap-1.5 bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 rounded-lg px-2.5 py-1 text-xs font-semibold animate-fadeIn"
          >
            <span>{city}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeCity(city);
              }}
              className="text-indigo-400 hover:text-white hover:bg-indigo-500/30 rounded-md w-3.5 h-3.5 inline-flex items-center justify-center transition-colors"
              title="Remove city"
            >
              <CloseIcon className="w-2.5 h-2.5" />
            </button>
          </span>
        ))}

        {/* Inline Input */}
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlighted(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={selectedCities.length === 0 ? placeholder : 'Add another city…'}
          className="flex-1 min-w-[130px] text-sm text-white placeholder-slate-500 font-medium focus:outline-none bg-transparent py-0.5 px-1"
          autoComplete="off"
        />

        {selectedCities.length > 1 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange([]);
            }}
            className="text-[11px] text-slate-500 hover:text-slate-300 px-2 py-0.5 rounded transition-colors"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Autocomplete Dropdown */}
      {open && items.length > 0 && (
        <ul className="absolute z-50 left-0 right-0 w-full bg-[#0C1322]/95 border border-indigo-500/30 rounded-xl mt-1.5 max-h-72 overflow-y-auto shadow-2xl divide-y divide-white/5 animate-fadeIn backdrop-blur-xl">
          {items.map((item, idx) => (
            <li
              key={item + idx}
              className={`px-4 py-2.5 text-sm cursor-pointer flex items-center justify-between transition-colors ${
                idx === highlighted
                  ? 'bg-indigo-600/20 text-indigo-200 font-semibold'
                  : 'text-slate-300 hover:bg-white/5'
              }`}
              onMouseEnter={() => setHighlighted(idx)}
              onMouseDown={(e) => {
                e.preventDefault();
                addCity(item);
              }}
            >
              <div className="flex items-center gap-2.5">
                <MapPinIcon className="w-4 h-4 text-slate-500" />
                <span>{item}</span>
              </div>
              <span className="inline-flex items-center gap-1 text-[11px] text-indigo-400 bg-indigo-500/15 border border-indigo-500/30 font-semibold px-2 py-0.5 rounded-md">
                <PlusIcon className="w-3 h-3" />
                <span>Add</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mt-1.5 text-xs text-rose-400 font-medium">{error}</p>}
    </div>
  );
}
