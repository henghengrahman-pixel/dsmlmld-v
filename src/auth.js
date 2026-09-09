import crypto from 'node:crypto';
import { config } from './config.js';

function b64url(input) { return Buffer.from(input).toString('base64url'); }
function sign(payload) {
  return crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
}
export function createSession(username) {
  const body = b64url(JSON.stringify({ u: username, exp: Date.now() + 12 * 3600_000 }));
  return `${body}.${sign(body)}`;
}
export function verifySession(token='') {
  const [body, sig] = token.split('.');
  if (!body || !sig || !config.sessionSecret) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}
export function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const i = v.indexOf('=');
    return [decodeURIComponent(i >= 0 ? v.slice(0,i) : v), decodeURIComponent(i >= 0 ? v.slice(i+1) : '')];
  }));
}
export function requireAdmin(req, res, next) {
  const session = verifySession(parseCookies(req).lcai_session || '');
  if (!session) return res.status(401).json({ ok:false, error:'UNAUTHORIZED' });
  req.admin = session;
  next();
}
