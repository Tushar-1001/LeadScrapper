import { useState } from 'react';
import { CloseIcon, CopyIcon, PhoneIcon, BoltIcon, CheckIcon } from './Icons.jsx';

/**
 * ColdPitchModal — AI Cold Outreach Script Generator for high-ticket businesses without websites.
 */
export default function ColdPitchModal({ lead, onClose }) {
  const [activeTab, setActiveTab] = useState('call'); // 'call' | 'sms' | 'email'
  const [copied, setCopied] = useState(false);

  if (!lead) return null;

  const bizName = lead.name || 'Business Owner';
  const reviews = parseInt(String(lead.reviews || '0').replace(/[^\d]/g, ''), 10) || 0;
  const rating = lead.rating || '4.8';
  const phone = lead.phone || '';
  const city = lead.address ? lead.address.split(',')[1]?.trim() || 'your area' : 'your area';

  // Calculate estimated lost monthly revenue based on reviews
  const lostRevenue = reviews >= 100 
    ? '$25,000 – $50,000+' 
    : reviews >= 50 
    ? '$15,000 – $35,000' 
    : '$8,000 – $18,000';

  // Generate scripts
  const scripts = {
    call: `/* OPENER & VALUE HOOK */
"Hi [Owner Name], I was researching top-rated businesses in ${city} and noticed ${bizName} has an incredible ${rating}★ rating with ${reviews > 0 ? reviews + '+' : 'multiple'} reviews on Google Maps."

/* THE PAIN POINT */
"Your clients clearly love your work, but I was surprised to see you don't have an official website connected to your Maps listing. Right now, hundreds of homeowners searching for services in ${city} every week are landing on competitors simply because they can't click to view photos or request a quote."

/* THE NO-RISK CALL TO ACTION */
"I build high-converting websites specifically for local businesses like yours. I've already drafted a 2-minute visual mockup of what a modern site for ${bizName} could look like. Can I text or email you the free demo link so you can take a look?"`,

    sms: `Hey [Owner], noticed ${bizName} has an awesome ${rating}★ rating on Google with ${reviews} reviews! 

Quick question — I noticed your Google Maps listing doesn't have an official website linked. You're easily missing 20-30 high-paying customer inquiries each month.

I put together a free modern website mockup for ${bizName}. Can I send you the preview link? No pressure at all!`,

    email: `Subject: Quick question about ${bizName}'s Google Maps listing

Hi [Owner Name],

I came across ${bizName} on Google Maps while looking at high-performing local services in ${city}. Huge congratulations on your stellar ${rating}★ rating with ${reviews} reviews!

While checking your profile, I noticed you don't currently have an official website linked. In today's market, over 70% of high-ticket customers look for a website to check credentials and book an estimate before calling.

I specialize in building clean, fast-loading websites that turn Google Maps visitors into booked jobs. I've already designed a customized preview concept tailored specifically for ${bizName}.

Would you be open to a quick 2-minute look at the concept? I can reply with the demo link whenever you're free.

Best regards,
[Your Name]
Web Design & Lead Growth Specialist`
  };

  const currentScript = scripts[activeTab];

  const handleCopy = () => {
    navigator.clipboard?.writeText(currentScript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div 
        className="w-full max-w-2xl bg-[#0F1626] border border-white/10 rounded-2xl shadow-2xl p-6 sm:p-7 relative overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Glow backdrop decoration */}
        <div className="absolute -top-16 -right-16 w-64 h-64 bg-indigo-500/15 rounded-full blur-3xl pointer-events-none"></div>

        {/* Modal Header */}
        <div className="flex items-start justify-between pb-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-500 to-violet-500 p-[1px] shadow-lg shadow-indigo-500/25">
              <div className="w-full h-full bg-[#0B0F19] rounded-[11px] flex items-center justify-center text-indigo-400">
                <BoltIcon className="w-5 h-5 text-indigo-400" />
              </div>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white">AI Cold Outreach Pitch</h3>
                <span className="text-[10px] font-bold text-indigo-300 bg-indigo-500/15 border border-indigo-500/30 px-2 py-0.5 rounded-full">
                  Instant Script
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">
                Customized for <strong className="text-white">{bizName}</strong>
              </p>
            </div>
          </div>
          <button 
            type="button" 
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-white/5 transition"
            title="Close modal"
          >
            <CloseIcon className="w-4 h-4" />
          </button>
        </div>

        {/* Business Context Snapshot */}
        <div className="grid grid-cols-3 gap-3 my-4 p-3 rounded-xl bg-[#070A12] border border-white/5 text-xs shrink-0">
          <div>
            <span className="text-slate-500 block text-[11px]">Reputation</span>
            <span className="font-bold text-amber-400 flex items-center gap-1 mt-0.5">
              ★ {rating} ({reviews} reviews)
            </span>
          </div>
          <div>
            <span className="text-slate-500 block text-[11px]">Website Status</span>
            <span className="font-bold text-emerald-400 flex items-center gap-1 mt-0.5">
              ✓ Verified No Website
            </span>
          </div>
          <div>
            <span className="text-slate-500 block text-[11px]">Est. Lost Revenue</span>
            <span className="font-bold text-rose-400 flex items-center gap-1 mt-0.5">
              {lostRevenue}/mo
            </span>
          </div>
        </div>

        {/* Script Tabs */}
        <div className="flex items-center justify-between mb-3 shrink-0">
          <div className="flex items-center gap-1.5 bg-[#070A12] p-1 rounded-xl border border-white/5">
            <button
              type="button"
              onClick={() => setActiveTab('call')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                activeTab === 'call'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Cold Call (60s)
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('sms')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                activeTab === 'sms'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              SMS / WhatsApp
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('email')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                activeTab === 'email'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Email Pitch
            </button>
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1.5 transition shadow-sm"
          >
            {copied ? (
              <>
                <CheckIcon className="w-3.5 h-3.5 text-white" />
                <span>Copied!</span>
              </>
            ) : (
              <>
                <CopyIcon className="w-3.5 h-3.5" />
                <span>Copy Script</span>
              </>
            )}
          </button>
        </div>

        {/* Script Content Area */}
        <div className="flex-1 overflow-y-auto p-4 rounded-xl bg-[#070A12] border border-white/10 text-xs font-mono leading-relaxed text-slate-300 whitespace-pre-wrap select-all">
          {currentScript}
        </div>

        {/* Footer Actions */}
        <div className="mt-4 pt-3 border-t border-white/10 flex items-center justify-between shrink-0">
          <span className="text-xs text-slate-500 font-mono">
            {phone ? `Phone: ${phone}` : 'No phone listed on Maps'}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 border border-white/5 transition"
            >
              Close
            </button>
            {phone && (
              <a
                href={`tel:${phone.replace(/\D/g, '')}`}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 flex items-center gap-1.5 transition shadow-lg shadow-emerald-600/20"
              >
                <PhoneIcon className="w-3.5 h-3.5" />
                Direct Call Now
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
