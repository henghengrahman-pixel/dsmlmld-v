export const CATEGORIES=['RESET_PASSWORD','WD_PROBLEM','BONUS'];
export function bridgeCategory(intent='GENERAL'){
  const s=String(intent||'').toUpperCase();
  if(s==='FORGOT_PASSWORD'||s.includes('PASSWORD')) return 'RESET_PASSWORD';
  if(s==='WITHDRAW_PROBLEM'||s.includes('WITHDRAW')||s.startsWith('WD_')) return 'WD_PROBLEM';
  if(s.includes('BONUS')) return 'BONUS';
  return 'PANEL_ONLY';
}
export function isTelegramBridgeCategory(intent='GENERAL'){
  return ['RESET_PASSWORD','WD_PROBLEM','BONUS'].includes(bridgeCategory(intent));
}
