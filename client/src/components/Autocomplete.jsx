import { useState, useRef, useEffect } from 'react';
import { BuildingIcon, CloseIcon } from './Icons.jsx';

/**
 * Autocomplete — Modern searchable dropdown for business categories (Dark Glassmorphic UI).
 */
export default function Autocomplete({
  suggestions = [],
  value,
  onChange,
  placeholder,
  error,
  icon: IconComponent = BuildingIcon,
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [highlighted, setHighlighted] = useState(-1);
  const wrapperRef = useRef(null);
  const inputRef = useRef(null);

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

  // Filter items based on query
  useEffect(() => {
    if (!value || value.length < 1) {
      setItems(suggestions.slice(0, 14));
      return;
    }

    const lower = value.toLowerCase().trim();
    const localMatches = suggestions.filter((s) =>
      s.toLowerCase().includes(lower)
    );
    setItems(localMatches.slice(0, 16));
  }, [value, suggestions]);

  function handleKeyDown(e) {
    if (!open || items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((h) => (h + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((h) => (h - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' && highlighted >= 0 && items[highlighted]) {
      e.preventDefault();
      onChange(items[highlighted]);
      setOpen(false);
      setHighlighted(-1);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <div ref={wrapperRef} className="relative group">
      <div className="relative">
        {IconComponent && (
          <div className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400 group-focus-within:text-indigo-400 transition-colors duration-200">
            <IconComponent className="w-4 h-4 text-indigo-400" />
          </div>
        )}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setOpen(true);
            setHighlighted(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={`w-full bg-surface-900 border rounded-xl py-3 px-4 ${
            IconComponent ? 'pl-10' : ''
          } pr-10 text-sm text-white placeholder-slate-500 font-medium focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500/50 transition-all shadow-inner ${
            error
              ? 'border-rose-500 ring-1 ring-rose-500/30'
              : 'border-white/10 hover:border-white/20'
          }`}
          autoComplete="off"
        />
        {value && (
          <button
            type="button"
            onClick={() => {
              onChange('');
              setOpen(true);
              inputRef.current?.focus();
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 w-6 h-6 flex items-center justify-center rounded-lg hover:bg-white/5 transition-colors"
            title="Clear"
          >
            <CloseIcon className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && items.length > 0 && (
        <ul className="absolute z-50 w-full bg-[#0F1626] border border-white/10 rounded-xl mt-1.5 max-h-60 overflow-y-auto shadow-2xl divide-y divide-white/5 animate-fadeIn">
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
                onChange(item);
                setOpen(false);
                setHighlighted(-1);
              }}
            >
              <div className="flex items-center gap-2.5">
                <BuildingIcon className="w-4 h-4 text-slate-500" />
                <span>{item}</span>
              </div>
              {value && item.toLowerCase().startsWith(value.toLowerCase().trim()) && (
                <span className="text-[10px] text-indigo-400 bg-indigo-500/15 border border-indigo-500/30 font-bold uppercase tracking-wider px-2 py-0.5 rounded">
                  Match
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mt-1.5 text-xs text-rose-400 font-medium">{error}</p>}
    </div>
  );
}
