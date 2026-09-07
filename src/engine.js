import { config } from './config.js';
import { normalizeText, detectIntent } from './normalizer.js';
import { OpenAIClient } from './ai.js';
import * as db from './db.js';
import { guardDecision } from './guard.js';

const ai = new OpenAIClient();

function formatRows(rows, fields){ return rows.map(r=>fields.map(f=>r[f]).filter(Boolean).join(' | ')).join('\n'); }

export async function processCustomerMessage({chatId,eventId,text,createdAt,livechat}) {
  const normalized=normalizeText(text); const intent=detectIntent(text);
  const inserted=await db.insertMessage({chatId,eventId,senderType:'customer',text,normalizedText:normalized,intent,createdAt,authorId:''});
  if (!inserted) return {skipped:'duplicate'};
  if (await db.isHumanTakeover(chatId)) return {skipped:'human_takeover'};
  const auto=Boolean(await db.getSetting('auto_reply',config.autoReplyDefault));
  if (!auto) return {skipped:'auto_reply_off',intent,normalized};

  const contextRows=await db.getContext(chatId,config.aiMaxContext);
  const rulesRows=await db.getRules(intent); const kbRows=await db.getKnowledge(intent);
  const context=contextRows.map(m=>`${m.sender_type==='customer'?'MEMBER':'AGENT'}: ${m.text}`).join('\n');
  const rules=formatRows(rulesRows,['category','rule_type','content']);
  const knowledge=formatRows(kbRows,['category','title','content']);
  try {
    let decision=await ai.classifyAndReply({normalized,intent,context,rules,knowledge});
    if (decision.confidence < config.aiConfidence) decision.action='HANDOFF';
    decision=guardDecision({intent,decision,hasKnowledge:Boolean(knowledge)});
    if (decision.action==='HANDOFF' || !decision.reply) {
      await db.logAI({chatId,sourceEventId:eventId,intent,...decision});
      return {intent,decision};
    }
    const sent=await livechat.sendMessage(chatId,decision.reply);
    const sentEventId=sent?.event_id || sent?.id || null;
    await db.saveOutbound(chatId,decision.reply,sentEventId);
    await db.logAI({chatId,sourceEventId:eventId,intent,...decision});
    return {intent,decision,sent:true};
  } catch (e) {
    await db.logAI({chatId,sourceEventId:eventId,intent,error:e.message});
    await db.logError('engine','AI_PROCESS_FAILED',e.message,{chatId,eventId,intent});
    return {intent,error:e.message};
  }
}
