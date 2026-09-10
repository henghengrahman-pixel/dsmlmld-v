export const CATEGORIES=['RESET_PASSWORD','WD_PROBLEM','DEPOSIT_PROBLEM','BONUS','ISSUE'];
export function bridgeCategory(intent='GENERAL'){
  const s=String(intent||'').toUpperCase();
  if(s==='FORGOT_PASSWORD'||s.includes('PASSWORD')) return 'RESET_PASSWORD';
  if(s==='WITHDRAW_PROBLEM'||s.includes('WITHDRAW')||s.startsWith('WD_')||s==='ACCOUNT_CHANGE_REQUEST') return 'WD_PROBLEM';
  if(s==='DEPOSIT_PROBLEM'||s.startsWith('DP_')||s.includes('DEPOSIT')) return 'DEPOSIT_PROBLEM';
  if(s.includes('BONUS')) return 'BONUS';
  if(['LOGIN_PROBLEM','LINK_PROBLEM','GAME_PROBLEM','GENERAL_DISTURBANCE','ISSUE'].includes(s)) return 'ISSUE';
  return 'PANEL_ONLY';
}
export function isTelegramBridgeCategory(intent='GENERAL'){
  return ['RESET_PASSWORD','WD_PROBLEM','DEPOSIT_PROBLEM','BONUS','ISSUE'].includes(bridgeCategory(intent));
}
