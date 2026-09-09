export function sanitizeCorrection(text=''){
  return String(text||'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,' ').trim().slice(0,1600);
}
export function learningLabel(item={}){
  const src=String(item.source_type||'HUMAN_CHAT').toUpperCase();
  return src==='AI_FEEDBACK'?'Teguran AI':'Chat CS';
}
