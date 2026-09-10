export const CONVERSATION_STATES = Object.freeze([
  'NEW','BOT_ACTIVE','WAITING_MEMBER','WAITING_MEMBER_ID','WAITING_PROOF','WAITING_HUMAN','HUMAN_ACTIVE','RESOLVED','CLOSED'
]);

export function normalizeConversationState(value='NEW') {
  const s=String(value||'NEW').toUpperCase();
  return CONVERSATION_STATES.includes(s)?s:'NEW';
}

export function stateFromWorkflow(workflowType='', workflowState='') {
  const t=String(workflowType||'').toUpperCase();
  const s=String(workflowState||'').toUpperCase();
  if(/WAITING_(?:ID|MEMBER_ID)/.test(s)) return 'WAITING_MEMBER_ID';
  if(/WAITING_(?:PROOF|CLEAR_PROOF|DETAIL_PROOF|DEPOSIT_PROOF)/.test(s)) return 'WAITING_PROOF';
  if(s.startsWith('WAITING_') || s==='ASK_TYPE' || s==='WAITING_DEPOSIT') return 'WAITING_MEMBER';
  if(t && s) return 'BOT_ACTIVE';
  return 'BOT_ACTIVE';
}

export function canBotProcess({conversationState='NEW',humanTakeover=false,closed=false}={}) {
  if(closed || normalizeConversationState(conversationState)==='CLOSED') return false;
  if(humanTakeover || normalizeConversationState(conversationState)==='HUMAN_ACTIVE') return false;
  return true;
}
