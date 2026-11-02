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
    console.log(`[store] Firestore (${dbId || '(default)'})`);
    store = {
      async create(letter) { await col.doc(letter.code).set(letter); },
      async get(code) { const s = await col.doc(code).get(); return s.exists ? s.data() : null; },
      async addView(code) { await col.doc(code).update({ views: FieldValue.increment(1), openedAt: Date.now() }); },
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
  const save = d => fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log('[store] 로컬 JSON 파일 (FIREBASE_SERVICE_ACCOUNT 없음)');
  store = {
    async create(l) { const d = load(); d[l.code] = l; save(d); },
    async get(code) { return load()[code] || null; },
    async addView(code) { const d = load(); if (d[code]) { d[code].views = (d[code].views || 0) + 1; d[code].openedAt = Date.now(); save(d); } },
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
    if (!mine && req.query.view === '1') await store.addView(code).catch(() => {});
    res.json({ code: L.code, to: L.to, text: L.text, nick: L.nick, createdAt: L.createdAt, mine });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

// 내가 보낸 편지 현황
app.get('/api/status', async (req, res) => {
  try {
    const token = req.get('x-sender-token');
    if (!isToken(token)) return res.status(400).json({ error: 'bad_request' });
    const list = await store.bySender(token);
    res.json({ letters: list.map(l => ({ code: l.code, to: l.to, text: l.text, nick: l.nick, createdAt: l.createdAt, views: l.views || 0, openedAt: l.openedAt || null })) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server_error' }); }
});

app.get('/healthz', (_, res) => res.send('ok'));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initStore().then(() => app.listen(PORT, () => console.log(`💌 letterbox on http://localhost:${PORT}`)))
  .catch(e => { console.error('store init failed', e); process.exit(1); });
