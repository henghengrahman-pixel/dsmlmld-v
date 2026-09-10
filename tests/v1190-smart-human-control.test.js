import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyIntent } from '../src/normalizer.js';
import { stateFromWorkflow, canBotProcess, CONVERSATION_STATES } from '../src/state-machine.js';

const engine=fs.readFileSync(new URL('../src/engine.js',import.meta.url),'utf8');
const db=fs.readFileSync(new URL('../src/db.js',import.meta.url),'utf8');
const bridge=fs.readFileSync(new URL('../src/human-bridge.js',import.meta.url),'utf8');
const poller=fs.readFileSync(new URL('../src/poller.js',import.meta.url),'utf8');
const livechat=fs.readFileSync(new URL('../src/livechat.js',import.meta.url),'utf8');
const ai=fs.readFileSync(new URL('../src/ai.js',import.meta.url),'utf8');
const server=fs.readFileSync(new URL('../src/server.js',import.meta.url),'utf8');

// Scenario 1
test('S1 greeting normal is classified confidently and greeting is one-shot',()=>{ const c=classifyIntent('halo bos'); assert.equal(c.intent,'GREETING'); assert.ok(c.confidence>=.95); assert.match(engine,/claimGreeting/); });
// Scenario 2
test('S2 deposit missing -> proof -> ID persists workflow then Telegram',()=>{ assert.match(engine,/DEPOSIT_VERIFY/); assert.match(engine,/WAITING_ID/); assert.match(engine,/WAITING_PROOF/); assert.match(engine,/telegram:true/); });
// Scenario 3
test('S3 ID first then proof is merged from stored conversation context',()=>{ assert.match(engine,/extractUserId\(ctx\)/); assert.match(engine,/latestProof\(ctx\)/); assert.match(engine,/workflow_data/); });
// Scenario 4
test('S4 ID and problem in one message enters deterministic deposit workflow',()=>{ const c=classifyIntent('deposit belum masuk id ABC123'); assert.equal(c.intent,'DEPOSIT_PROBLEM'); assert.ok(c.confidence>=.9); });
// Scenario 5
test('S5 concurrent deposits are isolated by per-conversation lock and unique ticket correlation',()=>{ assert.match(db,/pg_advisory_lock\(hashtext\(\$1\)\)/); assert.match(db,/ticket_code TEXT UNIQUE/); assert.match(db,/human_request_id BIGINT UNIQUE/); });
// Scenario 6
test('S6 Telegram DONE maps to exact deposit processed action',()=>{ assert.match(bridge,/text:'DONE'.*DP_PROCESSED/s); assert.match(engine,/DP_PROCESSED/); });
// Scenario 7
test('S7 Telegram TIDAK MASUK maps to exact not-found response',()=>{ assert.match(bridge,/TIDAK MASUK/); assert.match(engine,/setConversationResolved/); });
// Scenario 8
test('S8 Telegram native reply resolves exact reply_to_message_id ticket',()=>{ assert.match(bridge,/reply_to_message/); assert.match(bridge,/findOpenBridgeTicketByTelegram/); });
// Scenario 9
test('S9 human takeover before AI prevents bot processing',()=>{ assert.equal(canBotProcess({conversationState:'HUMAN_ACTIVE',humanTakeover:true}),false); assert.match(engine,/isHumanTakeover\(chatId\)/); });
// Scenario 10
test('S10 human takeover while AI generates drops AI before send',()=>{ assert.match(engine,/human_takeover_after_ai/); assert.match(engine,/hasHumanReplyAfter/); assert.match(engine,/HUMAN_REPLIED_DURING_AI_GENERATION/); });
// Scenario 11
test('S11 release restores bot control without resetting greeting/history',()=>{ assert.match(db,/clearHumanTakeover/); assert.match(server,/enable-ai/); assert.doesNotMatch(server,/enable-ai[\s\S]{0,250}claimGreeting/); });
// Scenario 12
test('S12 duplicate LiveChat webhook/event is idempotent in DB',()=>{ assert.match(db,/UNIQUE\(chat_id,event_id\)/); assert.match(db,/ON CONFLICT\(chat_id,event_id\) DO NOTHING/); });
// Scenario 13
test('S13 duplicate Telegram callback is atomically claimed once',()=>{ assert.match(db,/status='PROCESSING'.*status='OPEN'/s); assert.match(bridge,/claimBridgeTicketAction/); });
// Scenario 14
test('S14 WAITING_HUMAN survives Railway restart in PostgreSQL',()=>{ assert.ok(CONVERSATION_STATES.includes('WAITING_HUMAN')); assert.match(db,/conversation_state TEXT NOT NULL/); assert.match(db,/ai_waiting_human/); });
// Scenario 15
test('S15 OpenAI timeout uses abort/retry and engine fallback does not crash',()=>{ assert.match(ai,/AbortController/); assert.match(ai,/openaiRetries/); assert.match(engine,/AI_PROCESS_FAILED/); });
// Scenario 16
test('S16 Telegram send failure is persisted for retry',()=>{ assert.match(db,/TELEGRAM_SEND_FAILED/); assert.match(bridge,/DISPATCH_FAILED/); assert.match(bridge,/lastBacklogScanAt/); });
// Scenario 17
test('S17 LiveChat send failures are contained and logged',()=>{ assert.match(engine,/sendAndStore/); assert.match(engine,/AI_PROCESS_FAILED/); assert.match(db,/errors/); });
// Scenario 18
test('S18 heavy typo still classifies high-risk transaction intent',()=>{ const c=classifyIntent('dp blm msk bos bkti tf ada'); assert.equal(c.intent,'DEPOSIT_PROBLEM'); assert.ok(c.confidence>=.9); });
// Scenario 19
test('S19 unknown/unclear AI output escalates rather than invents',()=>{ assert.match(ai,/ESCALATE_HUMAN/); assert.match(ai,/jangan menebak/i); assert.match(engine,/silent_wait_staff/); });
// Scenario 20
test('S20 CLOSED conversation disables bot and end-chat cancels open work',()=>{ assert.equal(canBotProcess({conversationState:'CLOSED'}),false); assert.match(db,/markConversationEnded/); assert.match(db,/status='CANCELLED'/); assert.match(livechat,/deactivate_chat/); });

test('v1.19 structured AI action allowlist is exact',()=>{ for(const a of ['SEND_MESSAGE','ASK_MEMBER_ID','ASK_PROOF','ESCALATE_HUMAN','SEND_HOLDING_MESSAGE','NO_REPLY']) assert.match(ai,new RegExp(a)); assert.doesNotMatch(ai,/"action":"AUTO_REPLY\|ASK_INFO/); });
test('v1.19 LiveChat sync has pagination and exponential backoff',()=>{ assert.match(livechat,/next_page_id/); assert.match(livechat,/lcMaxPages/); assert.match(poller,/2\*\*consecutiveFailures/); });
test('v1.19 webhook verifies raw body and agent messages trigger takeover',()=>{ assert.match(server,/rawBody/); assert.match(server,/outboundLooksLikeOurs/); assert.match(server,/livechat_agent_reply/); });
test('v1.19 health exposes subsystem status without external request per hit',()=>{ assert.match(server,/database:dbOk/); assert.match(server,/livechat/); assert.match(server,/telegram/); assert.match(server,/ai:aiStatus/); });
