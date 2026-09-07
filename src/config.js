export function bool(v, fallback=false) {
  if (v == null || v === '') return fallback;
  return ['1','true','yes','on'].includes(String(v).toLowerCase());
}
export function int(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
export const config = {
  port: int(process.env.PORT, 8080),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || '',
  databaseSsl: bool(process.env.DATABASE_SSL, false),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || '',

  lcAccountId: process.env.LIVECHAT_ACCOUNT_ID || '',
  lcPat: process.env.LIVECHAT_PAT || '',
  lcApiBase: (process.env.LIVECHAT_API_BASE || 'https://api.livechatinc.com/v3.5/agent/action').replace(/\/$/, ''),
  lcSyncMode: process.env.LIVECHAT_SYNC_MODE || 'polling',
  lcPollMs: Math.max(3000, int(process.env.LIVECHAT_POLL_MS, 10000)),
  lcListLimit: Math.min(100, Math.max(1, int(process.env.LIVECHAT_LIST_LIMIT, 100))),
  lcWebhookSecret: process.env.LIVECHAT_WEBHOOK_SECRET || '',

  openaiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
  openaiStyle: process.env.OPENAI_API_STYLE || 'responses',
  openaiMaxOutput: Math.max(64, int(process.env.OPENAI_MAX_OUTPUT_TOKENS, 220)),
  openaiTimeoutMs: Math.max(5000, int(process.env.OPENAI_TIMEOUT_MS, 20000)),

  aiMode: process.env.AI_MODE || 'safe_auto',
  aiConfidence: Number(process.env.AI_CONFIDENCE_THRESHOLD || 0.86),
  aiMaxContext: Math.min(50, Math.max(4, int(process.env.AI_MAX_CONTEXT_MESSAGES, 24))),
  autoReplyDefault: bool(process.env.AUTO_REPLY_ENABLED, false),
  humanTakeoverMinutes: Math.max(1, int(process.env.HUMAN_TAKEOVER_MINUTES, 30))
};

export function validateConfig() {
  const warnings = [];
  if (!config.databaseUrl) warnings.push('DATABASE_URL belum diisi');
  if (!config.adminPassword) warnings.push('ADMIN_PASSWORD belum diisi');
  if (config.sessionSecret.length < 32) warnings.push('SESSION_SECRET sebaiknya minimal 32 karakter');
  if (!config.lcAccountId || !config.lcPat) warnings.push('LIVECHAT_ACCOUNT_ID/LIVECHAT_PAT belum lengkap');
  if (!config.openaiKey) warnings.push('OPENAI_API_KEY belum diisi');
  return warnings;
}
