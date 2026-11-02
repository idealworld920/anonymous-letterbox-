import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const COLLECTION = 'letterbox_letters';

// ---------- 저장소: Firestore(운영) / JSON 파일(로컬 개발 폴백) ----------
let store;

async function initStore() {
  let svc = null;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else if (fs.existsSync(path.join(__dirname, 'serviceAccountKey.json'))) {
    svc = JSON.parse(fs.readFileSync(path.join(__dirname, 'serviceAccountKey.json'), 'utf8'));
  }

  if (svc) {
    const admin = (await import('firebase-admin')).default;
    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    admin.initializeApp({ credential: admin.credential.cert(svc) });
    const dbId = process.env.FIRESTORE_DATABASE_ID;
    const db = dbId ? getFirestore(admin.app(), dbId) : getFirestore();
    const col = db.collection(COLLECTION);
    const stats = db.collection('letterbox_stats');
    const visitors = db.collection('letterbox_visitors');
    const dayKey = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST
    const bump = async (field, n = 1) => {
      const inc = { [field]: FieldValue.increment(n), updatedAt: Date.now() };
      await Promise.all([stats.doc('total').set(inc, { merge: true }), stats.doc('day-' + dayKey()).set(inc, { merge: true })]);
    };
    console.log(`[store] Firestore (${dbId || '(default)'})`);
    store = {
      async create(letter) { await col.doc(letter.code).set(letter); },
      async get(code) { const s = await col.doc(code).get(); return s.exists ? s.data() : null; },
      async addView(code) { await col.doc(code).update({ views: FieldValue.increment(1), openedAt: Date.now() }); },
      async setReply(code, reply) { await col.doc(code).update({ reply }); },
      async remove(code) { await col.doc(code).delete(); },
      bump,
      async visit(token) {
        const ref = visitors.doc(token); const snap = await ref.get();
        if (!snap.exists) { await ref.set({ firstAt: Date.now(), lastAt: Date.now() }); await bump('visitors'); }
        else await ref.update({ lastAt: Date.now() });
        await bump('visits');
      },
      async stats() {
        const [t, d] = await Promise.all([stats.doc('total').get(), stats.doc('day-' + dayKey()).get()]);
        return { total: t.exists ? t.data() : {}, today: d.exists ? d.data() : {}, day: dayKey() };
      },
      async bySender(token) {
        const q = await col.where('senderToken', '==', token).orderBy('createdAt', 'desc').limit(100).get();
        return q.docs.map(d => d.data());
      },
    };
    return;
  }

  // 로컬 폴백
  const file = path.join(__dirname, 'data', 'letters.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const load = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});
  const sfile = path.join(__dirname, 'data', 'stats.json');
  const loadS = () => (fs.existsSync(sfile) ? JSON.parse(fs.readFileSync(sfile, 'utf8')) : {});
  const saveS = d => fs.writeFileSync(sfile, JSON.stringify(d, null, 2));
  const dayKeyL = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const save = d => fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log('[store] 로컬 JSON 파일 (FIREBASE_SERVICE_ACCOUNT 없음)');
  store = {
    async create(l) { const d = load(); d[l.code] = l; save(d); },
    async get(code) { return load()[code] || null; },
    async addView(code) { const d = load(); if (d[code]) { d[code].views = (d[code].views || 0) + 1; d[code].openedAt = Date.now(); save(d); } },
    async setReply(code, reply) { const d = load(); if (d[code]) { d[code].reply = reply; save(d); } },
    async remove(code) { const d = load(); delete d[code]; save(d); },
    bump: async (f, n = 1) => { const S = loadS(); for (const k of ['total', 'day-' + dayKeyL()]) { S[k] = S[k] || {}; S[k][f] = (S[k][f] || 0) + n; } saveS(S); },
    async visit(token) { const S = loadS(); S.visitors = S.visitors || {}; const first = !S.visitors[token]; S.visitors[token] = Date.now(); saveS(S); if (first) await this.bump('visitors'); await this.bump('visits'); },
    async stats() { const S = loadS(); return { total: S.total || {}, today: S['day-' + dayKeyL()] || {}, day: dayKeyL() }; },
    async bySender(t) { return Object.values(load()).filter(l => l.senderToken === t).sort((a, b) => b.createdAt - a.createdAt); },
  };
}

// ---------- 미들웨어 ----------
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const writeLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

const genCode = () => {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(8), b => a[b % a.length]).join('');
};
const clean = (s, max) => String(s || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const isToken = t => typeof t === 'string' && /^[a-f0-9-]{20,64}$/.test(t);

// ---------- API ----------
// 편지 봉인
app.post('/api/letters', writeLimit, async (req, res) => {
  try {
    const { to, text, nick, senderToken } = req.body || {};
    const T = clean(to, 20), X = clean(text, 500), N = clean(nick, 12);
    if (!T || X.length < 2 || !N || !isToken(senderToken)) return res.status(400).json({ error: 'bad_request' });
    const letter = { code: genCode(), to: T, text: X, nick: N, senderToken, createdAt: Date.now(), views: 0 };
    await store.create(letter);
    writing.delete(senderToken);
    store.bump('letters').catch(() => {});
    res.json({ code: letter.code });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// 편지 읽기 (보낸 사람 본인이면 열람수 안 올림, mine:true 반환)
app.get('/api/letters/:code', async (req, res) => {
  try {
    const code = String(req.params.code);
    if (!/^[a-z0-9]{6,12}$/.test(code)) return res.status(404).json({ error: 'not_found' });
    const L = await store.get(code);
    if (!L) return res.status(404).json({ error: 'not_found' });
    const token = req.get('x-sender-token');
    const mine = isToken(token) && token === L.senderToken;
    if (!mine && req.query.view === '1') { await store.addView(code).catch(() => {}); store.bump('reads').catch(() => {}); }
    res.json({ code: L.code, to: L.to, text: L.text, nick: L.nick, createdAt: L.createdAt, mine, reply: L.reply || null });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// 받는 사람의 익명 답장 (편지당 1통, 보낸 사람 본인은 불가)
app.post('/api/letters/:code/reply', writeLimit, async (req, res) => {
  try {
    const code = String(req.params.code);
    if (!/^[a-z0-9]{6,12}$/.test(code)) return res.status(404).json({ error: 'not_found' });
    const L = await store.get(code);
    if (!L) return res.status(404).json({ error: 'not_found' });
    const token = req.get('x-sender-token');
    if (isToken(token) && token === L.senderToken) return res.status(403).json({ error: 'own_letter' });
    if (L.reply) return res.status(409).json({ error: 'already_replied' });
    const text = clean(req.body?.text, 300);
    if (text.length < 2) return res.status(400).json({ error: 'bad_request' });
    const reply = { text, createdAt: Date.now() };
    await store.setReply(code, reply);
    store.bump('replies').catch(() => {});
    res.json({ ok: true, reply });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// 내 편지 삭제 (보낸 사람 본인만)
app.delete('/api/letters/:code', async (req, res) => {
  try {
    const code = String(req.params.code);
    if (!/^[a-z0-9]{6,12}$/.test(code)) return res.status(404).json({ error: 'not_found' });
    const L = await store.get(code);
    if (!L) return res.status(404).json({ error: 'not_found' });
    const token = req.get('x-sender-token');
    if (!isToken(token) || token !== L.senderToken) return res.status(403).json({ error: 'forbidden' });
    await store.remove(code);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// 내가 보낸 편지 현황
app.get('/api/status', async (req, res) => {
  try {
    const token = req.get('x-sender-token');
    if (!isToken(token)) return res.status(400).json({ error: 'bad_request' });
    const list = await store.bySender(token);
    res.json({ letters: list.map(l => ({ code: l.code, to: l.to, text: l.text, nick: l.nick, createdAt: l.createdAt, views: l.views || 0, openedAt: l.openedAt || null, reply: l.reply || null })) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// ---------- 방문/작성중 추적 ----------
const writing = new Map(); // token -> 마지막 작성 활동 시각 (메모리)
const WRITING_TTL = 2 * 60 * 1000;
const activeWriters = () => { const now = Date.now(); for (const [k, t] of writing) if (now - t > WRITING_TTL) writing.delete(k); return writing.size; };
const trackLimit = rateLimit({ windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
app.post('/api/track', trackLimit, async (req, res) => {
  try {
    const token = req.get('x-sender-token');
    if (!isToken(token)) return res.status(400).json({ error: 'bad_request' });
    const ev = String(req.body?.event || '');
    if (ev === 'visit') await store.visit(token);
    else if (ev === 'writing') writing.set(token, Date.now());
    else if (ev === 'writing_end') writing.delete(token);
    else return res.status(400).json({ error: 'bad_event' });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// ---------- 관리자 ----------
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const adminOk = req => ADMIN_KEY && (req.get('x-admin-key') === ADMIN_KEY || req.query.key === ADMIN_KEY);
app.get('/api/admin/stats', async (req, res) => {
  if (!ADMIN_KEY) return res.status(503).json({ error: 'admin_key_not_set' });
  if (!adminOk(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const st = await store.stats();
    const pick = o => ({ visits: o.visits || 0, visitors: o.visitors || 0, letters: o.letters || 0, reads: o.reads || 0, replies: o.replies || 0 });
    res.json({ day: st.day, total: pick(st.total), today: pick(st.today), writingNow: activeWriters(), serverTime: Date.now() });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.get('/healthz', (_, res) => res.send('ok'));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initStore().then(() => app.listen(PORT, () => console.log(`💌 letterbox on http://localhost:${PORT}`)))
  .catch(e => { console.error('store init failed', e); process.exit(1); });
