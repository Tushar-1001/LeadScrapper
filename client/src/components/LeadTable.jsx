import { useState, useMemo } from 'react';
import {
  MapPinIcon,
  PhoneIcon,
  CopyIcon,
  ExternalLinkIcon,
  BoltIcon,
  FlameIcon,
  CheckIcon,
} from './Icons.jsx';

/**
 * LeadTable — High-end Dark Glassmorphic Prospect Table for LeadScrapper Pro.
 * Features Intent Priority Badges, Dual-Layer Verified Badges, and AI Cold Pitch triggers.
 */
export default function LeadTable({ leads = [], onOpenPitch, scanDuration }) {
  const [copiedIdx, setCopiedIdx] = useState(null);

  // Ensure leads are sorted by number of reviews descending
  const displayLeads = useMemo(() => {
    return [...leads].sort((a, b) => {
      const revA = parseInt(String(a.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
      const revB = parseInt(String(b.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
      if (revB !== revA) return revB - revA;
      const rateA = parseFloat(a.rating) || 0;
      const rateB = parseFloat(b.rating) || 0;
      return rateB - rateA;
    });
  }, [leads]);

  if (!displayLeads || displayLeads.length === 0) return null;

  const copyPhone = (phone, idx) => {
    if (!phone) return;
    navigator.clipboard?.writeText(phone);
    setCopiedIdx(idx);
    setTimeout(() => setCopiedIdx(null), 1800);
  };

  const getPriorityBadge = (reviewsCount) => {
    if (reviewsCount >= 50) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">
          <span>🔥</span> HOT LEAD
        </span>
      );
    }
    if (reviewsCount >= 10) {
      return (
        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-blue-500/15 text-blue-300 border border-blue-500/30">
          <span>⚡</span> WARM
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-white/5 text-slate-400 border border-white/5">
        STANDARD
      </span>
    );
  };

  return (
    <div className="glass-panel rounded-2xl overflow-hidden border border-white/10 shadow-2xl transition-all">
      {/* Table Header Bar */}
      <div className="px-6 py-4 border-b border-white/5 flex flex-wrap items-center justify-between gap-3 bg-surface-850/60">
        <div className="flex items-center gap-3">
          <div className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
          </div>
          <h2 className="text-sm font-bold text-white tracking-wide uppercase flex items-center gap-2">
            <span>Verified High-Ticket Prospects</span>
            <span className="text-[10px] font-bold text-indigo-400 bg-indigo-500/15 px-2 py-0.5 rounded-full border border-indigo-500/30 font-mono">
              {displayLeads.length} {displayLeads.length === 1 ? 'Record' : 'Records'}
            </span>
            {scanDuration && (
              <span className="text-[10px] font-bold text-emerald-400 bg-emerald-500/15 px-2 py-0.5 rounded-full border border-emerald-500/30 font-mono flex items-center gap-1">
                ⚡ Found in {scanDuration}s
              </span>
            )}
          </h2>
        </div>
        <div className="text-xs text-slate-400 flex items-center gap-2 font-medium">
          <span className="flex items-center gap-1 text-emerald-400">
            <CheckIcon className="w-3.5 h-3.5" />
            Dual-Layer Verified (No Website)
          </span>
          <span>•</span>
          <span className="text-indigo-400">Sorted: Most Reviews ↓</span>
        </div>
      </div>

      {/* Responsive Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm text-left">
          <thead>
            <tr className="bg-surface-900/90 text-slate-400 border-b border-white/5 text-[11px] uppercase font-bold tracking-wider">
              <th className="px-5 py-3.5 w-16 text-center">Rank</th>
              <th className="px-5 py-3.5">Business & Location</th>
              <th className="px-5 py-3.5">Phone & Contact</th>
              <th className="px-5 py-3.5">Google Reputation</th>
              <th className="px-5 py-3.5">Lead Priority</th>
              <th className="px-5 py-3.5 text-right">Quick Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 font-sans">
            {displayLeads.map((lead, idx) => {
              const reviewsCount = parseInt(String(lead.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
              const formattedRank = String(idx + 1).padStart(2, '0');

              return (
                <tr
                  key={idx}
                  className="hover:bg-indigo-500/[0.04] transition-colors group"
                >
                  {/* Rank */}
                  <td className="px-5 py-4 text-center font-mono text-xs font-bold text-slate-500 group-hover:text-indigo-400 transition">
                    #{formattedRank}
                  </td>

                  {/* Business Name & Address */}
                  <td className="px-5 py-4">
                    <div className="font-bold text-white group-hover:text-indigo-300 transition text-sm flex items-center gap-2">
                      <span>{lead.name || '—'}</span>
                      <span className="text-[10px] font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.2 rounded shrink-0">
                        No Site
                      </span>
                    </div>
                    {lead.address && (
                      <div className="text-xs text-slate-400 mt-1 flex items-center gap-1.5">
                        <MapPinIcon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                        <span className="line-clamp-1">{lead.address}</span>
                      </div>
                    )}
                  </td>

                  {/* Phone */}
                  <td className="px-5 py-4 whitespace-nowrap">
                    {lead.phone ? (
                      <div className="flex items-center gap-2">
                        <a
                          href={`tel:${lead.phone.replace(/\D/g, '')}`}
                          className="font-mono text-xs font-semibold text-slate-200 hover:text-indigo-400 bg-surface-900 border border-white/10 px-2.5 py-1 rounded-lg transition"
                        >
                          {lead.phone}
                        </a>
                        <button
                          type="button"
                          onClick={() => copyPhone(lead.phone, idx)}
                          title="Copy phone"
                          className="p-1 rounded-md text-slate-500 hover:text-slate-300 hover:bg-white/5 transition"
                        >
                          {copiedIdx === idx ? (
                            <span className="text-[10px] text-emerald-400 font-bold">Copied!</span>
                          ) : (
                            <CopyIcon className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>
                    ) : (
                      <span className="text-slate-500 text-xs italic">No phone listed</span>
                    )}
                  </td>

                  {/* Google Reputation */}
                  <td className="px-5 py-4 whitespace-nowrap">
                    {lead.rating && lead.rating !== '—' ? (
                      <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20">
                        <span className="text-amber-400 font-bold text-xs">
                          ★ {lead.rating}
                        </span>
                        <span className="text-amber-300/80 text-xs font-medium">
                          ({reviewsCount > 0 ? reviewsCount : 1} reviews)
                        </span>
                      </div>
                    ) : (
                      <span className="text-slate-500 text-xs">—</span>
                    )}
                  </td>

                  {/* Lead Priority Badge */}
                  <td className="px-5 py-4 whitespace-nowrap">
                    {getPriorityBadge(reviewsCount)}
                  </td>

                  {/* Quick Actions */}
                  <td className="px-5 py-4 text-right whitespace-nowrap">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => onOpenPitch?.(lead)}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-indigo-300 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/30 flex items-center gap-1.5 transition active:scale-95"
                        title="Generate instant AI cold outreach script"
                      >
                        <BoltIcon className="w-3.5 h-3.5 text-indigo-400" />
                        <span>AI Pitch</span>
                      </button>

                      {lead.mapsLink && (
                        <a
                          href={lead.mapsLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-slate-300 bg-white/5 hover:bg-white/10 border border-white/10 flex items-center gap-1 transition"
                          title="View on Google Maps"
                        >
                          <span>Maps</span>
                          <ExternalLinkIcon className="w-3.5 h-3.5 text-slate-400" />
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
