import express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const origin = 'http://localhost:5173';
const callback = origin + '/auth/callback';
const cookie = 'rep_session';
const login = new URL(process.env.SF_LOGIN_URL || 'https://login.salesforce.com');
if (login.protocol !== 'https:' || !/^(login\.salesforce\.com|[\w.-]+\.my\.salesforce\.com)$/.test(login.hostname) || login.origin !== login.href.slice(0, -1)) {
  throw new Error('SF_LOGIN_URL must be a Salesforce login or My Domain origin.');
}

type Tokens = { access_token: string; refresh_token?: string; instance_url: string };
type Session = Tokens & { expires: number; refreshing?: Promise<boolean> };
const pending = new Map<string, { state: string; verifier: string; expires: number }>();
const sessions = new Map<string, Session>();
const random = () => randomBytes(32).toString('base64url');
const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, path: '/' };

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (req.get('host') !== 'localhost:5173') { res.sendStatus(421); return; }
  res.set({ 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'" });
  if (req.path.startsWith('/auth/') || req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

function readCookie(header: string | undefined, name: string) {
  return header?.split(/;\s*/).find(part => part.startsWith(name + '='))?.slice(name.length + 1) ?? '';
}

async function exchange(params: Record<string, string>): Promise<Tokens> {
  const response = await fetch(new URL('/services/oauth2/token', login), {
    method: 'POST', body: new URLSearchParams({ ...params, client_id: process.env.SF_CLIENT_ID!,
      client_secret: process.env.SF_CLIENT_SECRET! }), signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  if (!response.ok) throw new Error('OAuth exchange rejected');
  const tokens: Tokens = await response.json();
  const instance = new URL(tokens.instance_url);
  if (instance.protocol !== 'https:' || !instance.hostname.endsWith('.salesforce.com')
    || instance.username || instance.password || instance.port || !tokens.access_token) {
    throw new Error('Invalid Salesforce token response');
  }
  return { ...tokens, instance_url: instance.origin };
}

app.get('/auth/login', (_req, res) => {
  if (!process.env.SF_CLIENT_ID || !process.env.SF_CLIENT_SECRET) {
    res.status(503).send('Configure SF_CLIENT_ID and SF_CLIENT_SECRET in the local environment, then restart.');
    return;
  }
  const id = random();
  const state = random();
  const verifier = random();
  pending.set(id, { state, verifier, expires: Date.now() + 600_000 });
  res.cookie('rep_oauth', id, { ...cookieOptions, maxAge: 600_000 });
  const authorize = new URL('/services/oauth2/authorize', login);
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: process.env.SF_CLIENT_ID, redirect_uri: callback,
    scope: 'api refresh_token openid', state, prompt: 'login',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
  }).toString();
  res.redirect(authorize.href);
});

app.get('/auth/callback', async (req, res) => {
  const id = readCookie(req.headers.cookie, 'rep_oauth');
  const attempt = pending.get(id);
  pending.delete(id);
  res.clearCookie('rep_oauth', cookieOptions);
  if (!attempt || attempt.expires <= Date.now() || req.query.state !== attempt.state || typeof req.query.code !== 'string') {
    res.redirect('/?error=oauth');
    return;
  }
  try {
    const tokens = await exchange({ grant_type: 'authorization_code', code: req.query.code,
      redirect_uri: callback, code_verifier: attempt.verifier });
    sessions.delete(readCookie(req.headers.cookie, cookie));
    const sessionId = random();
    const maxAge = 8 * 60 * 60 * 1000;
    sessions.set(sessionId, { ...tokens, expires: Date.now() + maxAge });
    res.cookie(cookie, sessionId, { ...cookieOptions, maxAge }).redirect('/');
  } catch {
    res.redirect('/?error=oauth');
  }
});

async function salesforce(session: Session, path: string) {
  const request = () => fetch(new URL(path, session.instance_url), {
    headers: { Authorization: 'Bearer ' + session.access_token }, signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  const token = session.access_token;
  const response = await request();
  if (response.status !== 401 || !session.refresh_token) return response;
  if (token !== session.access_token) return request();
  session.refreshing ??= exchange({ grant_type: 'refresh_token', refresh_token: session.refresh_token })
    .then(tokens => { Object.assign(session, { ...tokens, refresh_token: tokens.refresh_token ?? session.refresh_token }); return true; })
    .catch(() => false)
    .finally(() => { delete session.refreshing; });
  return await session.refreshing ? request() : response;
}

app.get('/api/session', async (req, res) => {
  const id = readCookie(req.headers.cookie, cookie);
  const session = sessions.get(id);
  if (!session || session.expires <= Date.now()) { sessions.delete(id); res.sendStatus(401); return; }
  try {
    const identity = await salesforce(session, '/services/oauth2/userinfo');
    if (identity.status === 401) { sessions.delete(id); res.clearCookie(cookie, cookieOptions).sendStatus(401); return; }
    if (!identity.ok) { res.status(502).json({ error: 'Salesforce identity is unavailable.' }); return; }
    const profile = await identity.json();
    const query = new URLSearchParams({ q: 'SELECT Id, Name FROM Account ORDER BY Name, Id LIMIT 10' });
    const accounts = await salesforce(session, '/services/data/v68.0/query?' + query);
    if (accounts.status === 401) { sessions.delete(id); res.clearCookie(cookie, cookieOptions).sendStatus(401); return; }
    const data = await accounts.json();
    const limited = Array.isArray(data) && data.some(item => item.errorCode === 'REQUEST_LIMIT_EXCEEDED');
    res.json({ username: profile.preferred_username ?? profile.name, accounts: accounts.ok ? data.records : [],
      accountError: accounts.ok ? undefined : limited ? 'The Salesforce API limit was reached. Try again later.' : 'Salesforce accounts could not be loaded.' });
  } catch {
    res.status(502).json({ error: 'Salesforce is unavailable.' });
  }
});

app.post('/auth/logout', (req, res) => {
  if (req.get('origin') !== origin) { res.sendStatus(403); return; }
  sessions.delete(readCookie(req.headers.cookie, cookie));
  res.clearCookie(cookie, cookieOptions).sendStatus(204);
});

app.use(express.static(resolve('dist')));
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pending) if (entry.expires <= now) pending.delete(id);
  for (const [id, entry] of sessions) if (entry.expires <= now) sessions.delete(id);
}, 60_000).unref();
app.listen(5173, 'localhost', () => console.log('Rep Workspace: ' + origin));
