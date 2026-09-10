// Deterministic User ID parser used by claim/operational workflows.
// Current-message extraction must take priority over old conversation history.
export function extractUserIdFromText(value=''){
  const raw=String(value||'').trim();
  if(!raw) return '';
  const pats=[
    /\b(?:user\s*id|userid|username)\s*[:=\-]?\s*([a-z0-9][a-z0-9_.-]{2,39})\b/i,
    /\bid(?:\s*(?:saya|akun|nya)|\s+nya)?\s*[:=\-]?\s*([a-z0-9][a-z0-9_.-]{2,39})\b/i,
    /\b([a-z0-9][a-z0-9_.-]{2,39})\s+(?:adalah\s+)?id(?:\s*(?:saya|akun|nya)|\s+nya)?\b/i
  ];
  const blocked=new Set(['akun','saya','nya','bonus','harian','claim','klaim','deposit','withdraw','password','bos','bosku']);
  for(const re of pats){
    const m=raw.match(re);
    const candidate=String(m?.[1]||'').trim();
    if(!candidate || blocked.has(candidate.toLowerCase())) continue;
    return candidate;
  }
  return '';
}


// Claim-aware fallback: members often write "claim bonus bunglon8008" without an ID label.
// Only enable this inside bonus-claim workflows; never use it as a generic ID parser.
export function extractClaimUserIdFromText(value=''){
  const raw=String(value||'').trim();
  if(!raw) return '';
  const explicit=extractUserIdFromText(raw);
  if(explicit) return explicit;
  const n=raw.toLowerCase();
  if(!/\b(?:claim|klaim)\b/.test(n) || !/\b(?:bonus|event|cashback|rollingan|free\s*bet|freebet|ronda)\b/.test(n)) return '';
  const tokens=raw.match(/[a-z0-9_.-]{3,40}/ig)||[];
  const blocked=new Set([
    'claim','klaim','bonus','event','cashback','rollingan','freebet','free','bet','ronda','harian','mingguan','bulanan',
    'deposit','depo','slot','slotgames','livegames','live','games','casino','togel','new','member','referral','apk','freespin',
    'maxwin','scatter','hitam','senin','selasa','rabu','kamis','jumat','sabtu','minggu','bos','bosku','tolong','mau','minta'
  ]);
  for(let i=tokens.length-1;i>=0;i--){
    const t=tokens[i]; const low=t.toLowerCase();
    if(blocked.has(low)) continue;
    if(/^\d{8,22}$/.test(t.replace(/[^0-9]/g,''))) continue;
    // Require at least one digit for unlabeled claim IDs to avoid mistaking ordinary words/names.
    if(!/\d/.test(t)) continue;
    return t;
  }
  return '';
}
