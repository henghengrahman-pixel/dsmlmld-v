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
