const transactionClaims = [
  /\b(sudah|telah)\s+(berhasil|masuk|diproses|selesai|dibayarkan|dikreditkan)\b/i,
  /\bbonus\b.*\b(sudah|telah)\b.*\b(masuk|diproses|diberikan)\b/i,
  /\bwithdraw\b.*\b(sudah|telah)\b.*\b(berhasil|masuk|diproses)\b/i,
  /\bdeposit\b.*\b(sudah|telah)\b.*\b(berhasil|masuk|diproses)\b/i
];

export function guardDecision({ intent, decision, hasKnowledge=false }) {
  const result = { ...decision, blocked:false, blockReason:null };
  const text = String(decision?.reply || '');
  const sensitive = ['WITHDRAW_PROBLEM','DEPOSIT_PROBLEM','BONUS_DAILY','LOGIN_PROBLEM'].includes(intent);
  if (!text.trim()) {
    result.action='HANDOFF'; result.blocked=true; result.blockReason='EMPTY_REPLY'; return result;
  }
  if (sensitive && decision.action==='AUTO_REPLY' && !hasKnowledge) {
    result.action='HANDOFF'; result.blocked=true; result.blockReason='SENSITIVE_WITHOUT_KNOWLEDGE'; return result;
  }
  if (transactionClaims.some(r=>r.test(text)) && !hasKnowledge) {
    result.action='HANDOFF'; result.blocked=true; result.blockReason='UNVERIFIED_TRANSACTION_CLAIM'; return result;
  }
  return result;
}
