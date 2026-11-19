import { MapPinIcon, CheckIcon, CloseIcon } from './Icons.jsx';

/**
 * StatusBar — Shows scraping progress with dark glassmorphic styling, glow indicators, and live elapsed timer.
 */
export default function StatusBar({ status, isLoading, elapsedTime, scanDuration }) {
  if (!status) return null;

  const isError = status.includes('❌') || status.toLowerCase().includes('error');
  const isDone = status.includes('✅') || status.toLowerCase().includes('done') || status.toLowerCase().includes('complete');

  return (
    <div
      className={`rounded-2xl px-5 py-3.5 border transition-all duration-300 flex items-center justify-between gap-3.5 backdrop-blur-xl ${
        isError
          ? 'bg-rose-500/10 border-rose-500/25 text-rose-300'
          : isDone
          ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300'
          : 'bg-indigo-500/10 border-indigo-500/25 text-indigo-200'
      }`}
    >
      <div className="flex items-center gap-3.5 min-w-0">
        <div className="shrink-0 flex items-center justify-center">
          {isLoading ? (
            <div className="relative w-5 h-5 flex items-center justify-center">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-60"></span>
              <svg
                className="animate-spin h-5 w-5 text-indigo-400"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            </div>
          ) : isDone ? (
            <div className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center justify-center">
              <CheckIcon className="w-3 h-3" />
            </div>
          ) : isError ? (
            <div className="w-5 h-5 rounded-full bg-rose-500/20 text-rose-400 border border-rose-500/30 flex items-center justify-center">
              <CloseIcon className="w-3 h-3" />
            </div>
          ) : (
            <div className="w-5 h-5 text-indigo-400 flex items-center justify-center">
              <MapPinIcon className="w-4 h-4" />
            </div>
          )}
        </div>

        <div className="text-sm font-medium leading-relaxed tracking-wide truncate">
          {status.replace(/^[✅❌📍🔍🚀\s]+/, '')}
        </div>
      </div>

      {/* Live / Final Scan Timer Badge */}
      {isLoading && elapsedTime !== undefined && (
        <span className="shrink-0 text-xs font-mono font-bold text-indigo-300 bg-indigo-500/20 border border-indigo-500/30 px-2.5 py-1 rounded-lg flex items-center gap-1.5 shadow-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-ping"></span>
          <span>{elapsedTime}s</span>
        </span>
      )}
      {!isLoading && scanDuration && (
        <span className="shrink-0 text-xs font-mono font-bold text-emerald-300 bg-emerald-500/20 border border-emerald-500/30 px-2.5 py-1 rounded-lg flex items-center gap-1 shadow-sm">
          <span>⚡</span>
          <span>{scanDuration}s</span>
        </span>
      )}
    </div>
  );
}
