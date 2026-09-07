export const CATEGORIES=['RESET_PASSWORD','WD_PROBLEM','DEPOSIT_PROBLEM','BONUS','CUSTOM'];
export function bridgeCategory(intent='GENERAL'){
  const s=String(intent||'').toUpperCase();
  if(s==='FORGOT_PASSWORD'||s.includes('PASSWORD')) return 'RESET_PASSWORD';
  if(s==='WITHDRAW_PROBLEM'||s.includes('WITHDRAW')||s.startsWith('WD_')) return 'WD_PROBLEM';
  if(s==='DEPOSIT_PROBLEM'||s.includes('DEPOSIT')) return 'DEPOSIT_PROBLEM';
  if(s.includes('BONUS')) return 'BONUS';
  return 'CUSTOM';
}
