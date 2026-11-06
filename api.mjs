// Dead Wave 3.6 — API tài khoản (Netlify Functions v2 + Netlify Blobs)
// Routes: POST /api/register · POST /api/login · GET /api/me · PUT /api/save · POST /api/score · GET /api/top · POST /api/password
import { getStore } from '@netlify/blobs';
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const bad = (msg, status = 400) => json({ ok: false, err: msg }, status);
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const MAX_SAVE = 64 * 1024;
const TOKEN_DAYS = 45;

const users = () => getStore({ name: 'users', consistency: 'strong' });
const saves = () => getStore({ name: 'saves', consistency: 'strong' });
const misc = () => getStore({ name: 'misc', consistency: 'strong' });

async function secret() {
  if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 16) return process.env.AUTH_SECRET;
  const s = misc(); let v = await s.get('secret');
  if (!v) { v = randomBytes(32).toString('hex'); await s.set('secret', v); }
  return v;
}
const b64 = (b) => Buffer.from(b).toString('base64url');
async function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const mac = createHmac('sha256', await secret()).update(body).digest('base64url');
  return body + '.' + mac;
}
async function verify(tok) {
  if (!tok || typeof tok !== 'string' || tok.length > 600) return null;
  const [body, mac] = tok.split('.');
  if (!body || !mac) return null;
  const good = createHmac('sha256', await secret()).update(body).digest('base64url');
  const a = Buffer.from(mac), c = Buffer.from(good);
  if (a.length !== c.length || !timingSafeEqual(a, c)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); if (!p.u || p.exp < Date.now()) return null; return p; } catch { return null; }
}
const hashPw = (pw, salt) => scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
const key = (name) => name.toLowerCase();
async function authed(req) {
  const h = req.headers.get('authorization') || '';
  const p = await verify(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!p) return null;
  const u = await users().get(key(p.u), { type: 'json' });
  if (!u || u.tv !== p.tv) return null;
  return u;
}
const issue = async (u) => ({ token: await sign({ u: u.name, tv: u.tv, exp: Date.now() + TOKEN_DAYS * 864e5 }), name: u.name });

// làm sạch dữ liệu lưu trên mây (chỉ nhận các khóa đã biết, giới hạn kích thước)
function cleanSave(d) {
  if (!d || typeof d !== 'object') return null;
  const o = {};
  if (d.meta && typeof d.meta === 'object') {
    const m = d.meta, owned = {};
    if (m.owned && typeof m.owned === 'object') for (const k of Object.keys(m.owned).slice(0, 60)) if (/^[a-z0-9_]{1,24}$/.test(k)) owned[k] = m.owned[k] ? 1 : 0;
    o.meta = { gems: Math.max(0, Math.min(1e9, Math.floor(+m.gems || 0))), owned, cls: /^[a-z0-9_]{1,24}$/.test(m.cls) ? m.cls : 'soldier' };
  }
  if (d.bestd && typeof d.bestd === 'object') { o.bestd = {}; for (const k of Object.keys(d.bestd).slice(0, 12)) if (/^[a-z]{1,12}$/.test(k)) o.bestd[k] = Math.max(0, Math.min(100000, Math.floor(+d.bestd[k] || 0))); }
  if (d.set && typeof d.set === 'object') { o.set = {}; for (const k of ['gfx', 'vol', 'amb', 'shake', 'dn', 'bmRed']) if (typeof d.set[k] === 'number') o.set[k] = d.set[k]; }
  if (d.daily && typeof d.daily === 'object') o.daily = d.daily;
  if (typeof d.diff === 'string' && /^[a-z]{1,12}$/.test(d.diff)) o.diff = d.diff;
  if (JSON.stringify(o).length > MAX_SAVE) return null;
  return o;
}

async function readBody(req, max = 100 * 1024) {
  const t = await req.text();
  if (t.length > max) throw new Error('big');
  try { return JSON.parse(t || '{}'); } catch { throw new Error('json'); }
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/(\.netlify\/functions\/)?api\/?/, '').replace(/\/$/, '');
  try {
    if (req.method === 'POST' && path === 'register') {
      const b = await readBody(req, 2048);
      const name = String(b.user || '').trim(), pw = String(b.pass || '');
      if (!NAME_RE.test(name)) return bad('Tên 3–16 ký tự: chữ không dấu, số hoặc _');
      if (pw.length < 6 || pw.length > 64) return bad('Mật khẩu 6–64 ký tự');
      const st = users();
      if (await st.get(key(name))) return bad('Tên đã có người dùng', 409);
      const salt = randomBytes(16);
      const u = { name, salt: salt.toString('base64'), hash: hashPw(pw, salt).toString('base64'), tv: randomBytes(6).toString('hex'), created: Date.now(), best: 0, kills: 0, fails: 0, lock: 0 };
      await st.setJSON(key(name), u);
      return json({ ok: true, ...(await issue(u)) });
    }
    if (req.method === 'POST' && path === 'login') {
      const b = await readBody(req, 2048);
      const name = String(b.user || '').trim(), pw = String(b.pass || '');
      if (!NAME_RE.test(name)) return bad('Sai tên hoặc mật khẩu', 401);
      const st = users(), u = await st.get(key(name), { type: 'json' });
      if (!u) return bad('Sai tên hoặc mật khẩu', 401);
      if (u.lock > Date.now()) return bad('Nhập sai nhiều lần — thử lại sau ' + Math.ceil((u.lock - Date.now()) / 1000) + ' giây', 429);
      const ok = timingSafeEqual(hashPw(pw, Buffer.from(u.salt, 'base64')), Buffer.from(u.hash, 'base64'));
      if (!ok) { u.fails = (u.fails || 0) + 1; if (u.fails >= 5) { u.lock = Date.now() + 60000; u.fails = 0; } await st.setJSON(key(name), u); return bad('Sai tên hoặc mật khẩu', 401); }
      if (u.fails) { u.fails = 0; await st.setJSON(key(name), u); }
      return json({ ok: true, ...(await issue(u)) });
    }
    if (req.method === 'POST' && path === 'password') {
      const u = await authed(req); if (!u) return bad('Chưa đăng nhập', 401);
      const b = await readBody(req, 2048), op = String(b.old || ''), np = String(b.pass || '');
      if (np.length < 6 || np.length > 64) return bad('Mật khẩu mới 6–64 ký tự');
      if (!timingSafeEqual(hashPw(op, Buffer.from(u.salt, 'base64')), Buffer.from(u.hash, 'base64'))) return bad('Mật khẩu cũ không đúng', 401);
      const salt = randomBytes(16); u.salt = salt.toString('base64'); u.hash = hashPw(np, salt).toString('base64'); u.tv = randomBytes(6).toString('hex');
      await users().setJSON(key(u.name), u);
      return json({ ok: true, ...(await issue(u)) });
    }
    if (req.method === 'GET' && path === 'me') {
      const u = await authed(req); if (!u) return bad('Chưa đăng nhập', 401);
      const sv = await saves().get(key(u.name), { type: 'json' });
      return json({ ok: true, name: u.name, best: u.best || 0, save: sv || null });
    }
    if (req.method === 'PUT' && path === 'save') {
      const u = await authed(req); if (!u) return bad('Chưa đăng nhập', 401);
      const b = await readBody(req), d = cleanSave(b.data);
      if (!d) return bad('Dữ liệu không hợp lệ');
      const rec = { ts: Date.now(), data: d };
      await saves().setJSON(key(u.name), rec);
      return json({ ok: true, ts: rec.ts });
    }
    if (req.method === 'POST' && path === 'score') {
      const u = await authed(req); if (!u) return bad('Chưa đăng nhập', 401);
      const b = await readBody(req, 1024), wave = Math.floor(+b.wave || 0), kills = Math.floor(+b.kills || 0);
      if (wave < 1 || wave > 5000 || kills < 0 || kills > 1e7 || b.diff !== 'normal' && b.diff !== 'hard' && b.diff !== 'nightmare' && b.diff !== 'easy') return bad('Điểm không hợp lệ');
      if (b.cheat) return json({ ok: true, ignored: true });
      const st = misc(); const lb = (await st.get('lb', { type: 'json' })) || [];
      const i = lb.findIndex((r) => key(r.n) === key(u.name));
      const rec = { n: u.name, w: wave, k: kills, d: b.diff, t: Date.now() };
      if (i < 0) lb.push(rec); else if (wave > lb[i].w || (wave === lb[i].w && kills > lb[i].k)) lb[i] = rec;
      lb.sort((a, c) => c.w - a.w || c.k - a.k); lb.length = Math.min(lb.length, 100);
      await st.setJSON('lb', lb);
      if (wave > (u.best || 0)) { u.best = wave; await users().setJSON(key(u.name), u); }
      return json({ ok: true });
    }
    if (req.method === 'GET' && path === 'top') {
      const lb = (await misc().get('lb', { type: 'json' })) || [];
      return json({ ok: true, top: lb.slice(0, 30) });
    }
    // ---- báo hiệu phòng multiplayer (thay cho kênh công cộng bên ngoài) ----
    if (path.startsWith('sig/')) {
      const code = path.slice(4);
      if (!/^\d{6}$/.test(code)) return bad('Mã phòng không hợp lệ');
      const st = getStore({ name: 'sig', consistency: 'strong' }), now = Date.now();
      const prune = async (blobs) => { for (const b of blobs) { const t = +b.key.split('/')[1].split('-')[0]; if (now - t > 120000) st.delete(b.key).catch(() => {}); } };
      if (req.method === 'POST') {
        const raw = await req.text();
        if (raw.length > 16 * 1024) return bad('Quá lớn');
        const { blobs } = await st.list({ prefix: code + '/' });
        if (blobs.length > 60) return bad('Quá nhiều yêu cầu', 429);
        const key = `${code}/${now}-${randomBytes(3).toString('hex')}`;
        await st.set(key, raw);
        prune(blobs);
        return json({ ok: true, now });
      }
      if (req.method === 'GET') {
        const after = Math.max(0, +url.searchParams.get('after') || 0);
        const { blobs } = await st.list({ prefix: code + '/' });
        const keys = blobs.map((b) => b.key).filter((k) => +k.split('/')[1].split('-')[0] > after && now - +k.split('/')[1].split('-')[0] < 120000).sort().slice(-40);
        const msgs = [];
        for (const k of keys) { const m = await st.get(k); if (m) msgs.push({ t: +k.split('/')[1].split('-')[0], m }); }
        prune(blobs);
        return json({ ok: true, now, msgs });
      }
    }
    // ---- máy chủ TURN tuỳ chọn (đặt biến môi trường TURN_URLS, TURN_USER, TURN_PASS) ----
    if (req.method === 'GET' && path === 'ice') {
      const urls = (process.env.TURN_URLS || '').split(',').map((x) => x.trim()).filter(Boolean);
      const servers = urls.length ? [{ urls, username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' }] : [];
      return json({ ok: true, iceServers: servers });
    }
    return bad('Không tìm thấy', 404);
  } catch (e) {
    if (e && (e.message === 'big' || e.message === 'json')) return bad('Yêu cầu không hợp lệ');
    console.error('api error', e && e.stack || e);
    return bad('Lỗi máy chủ', 500);
  }
};
export const config = { path: ['/api/*'] };
