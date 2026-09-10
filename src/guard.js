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
    result.action='ESCALATE_HUMAN'; result.blocked=true; result.blockReason='EMPTY_REPLY'; return result;
  }
  // Until backend action agents are connected, never let AI assert that a transaction/bonus was actually completed.
  if (transactionClaims.some(r=>r.test(text))) {
    result.action='ESCALATE_HUMAN'; result.blocked=true; result.blockReason='UNVERIFIED_TRANSACTION_CLAIM'; return result;
  }
  if (sensitive && ['SEND_MESSAGE','SEND_HOLDING_MESSAGE'].includes(decision.action) && !hasKnowledge) {
    result.action='ESCALATE_HUMAN'; result.blocked=true; result.blockReason='SENSITIVE_WITHOUT_KNOWLEDGE'; return result;
  }
  return result;
}
