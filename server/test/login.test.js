'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pinProblem, randomPin } = require('../lib/auth');

const ADMIN_PASSWORD = 'correct horse battery';

async function startPortal() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-login-'));
  const site = path.join(root, 'site');
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site, 'data', 'gallery.json'), JSON.stringify({
    version: 1,
    artists: [
      { id: 'chris', name: 'Chris', page: 'chris.html', code: 'C' },
      { id: 'dexter', name: 'Dexter', page: 'dexter.html', code: 'D' },
    ],
    tags: [], studio: {},
    photos: [{ id: 'chris/a.jpg', artist: 'chris', file: 'chris/a.jpg', tags: [] }],
  }));
  process.env.PORTAL_DATA_DIR = path.join(root, 'data');
  process.env.PORTAL_SITE_DIR = site;
  delete require.cache[require.resolve('../portal')];
  const server = await require('../portal').start({ port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  const setupCode = fs.readFileSync(path.join(root, 'data', 'private', 'setup-code'), 'utf8').trim();
  return { server, base, data: path.join(root, 'data'), setupCode };
}

// A browser: keeps its cookie, sends the portal's own Origin, and comes from one IP.
function browser(base, ip = '203.0.113.5') {
  let cookie = null;
  const call = async (method, p, body, extraHeaders = {}) => {
    const headers = { 'X-Forwarded-For': ip, 'X-Forwarded-Host': 'borrowedtimetattoomckinney.com', ...extraHeaders };
    if (method === 'POST') {
      headers.Origin = headers.Origin || 'https://borrowedtimetattoomckinney.com';
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }
    if (cookie) headers.Cookie = cookie;
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = /Max-Age=0/.test(set) ? null : set.split(';')[0];
    return { status: r.status, body: await r.json(), setCookie: set };
  };
  return {
    get: p => call('GET', p),
    post: (p, body = {}, headers) => call('POST', p, body, headers),
    get cookie() { return cookie; },
  };
}

async function withAdmin(t) {
  const portal = await startPortal();
  t.after(() => portal.server.close());
  const admin = browser(portal.base, '198.51.100.1');
  const r = await admin.post('/studio/api/setup', { code: portal.setupCode, password: ADMIN_PASSWORD });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return { ...portal, admin };
}

test('PIN rules reject easy PINs and random PINs pass them', () => {
  for (const bad of ['12345', '1234567', 'abcdef', '000000', '111111', '123456', '654321', '121212', '123123', '112211'])
    assert.ok(pinProblem(bad), bad);
  for (const ok of ['482915', '730264']) assert.strictEqual(pinProblem(ok), null, ok);
  for (let i = 0; i < 200; i++) assert.strictEqual(pinProblem(randomPin()), null);
});

test('setup needs the one-time code, then the code is gone', async t => {
  const portal = await startPortal();
  t.after(() => portal.server.close());
  const b = browser(portal.base);
  assert.strictEqual((await b.get('/studio/api/status')).body.setupNeeded, true);
  assert.strictEqual((await b.post('/studio/api/setup', { code: 'wrong', password: ADMIN_PASSWORD })).status, 401);
  assert.strictEqual((await b.post('/studio/api/setup', { code: portal.setupCode, password: 'short' })).status, 400);
  const r = await b.post('/studio/api/setup', { code: portal.setupCode, password: ADMIN_PASSWORD });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.me, { role: 'admin', name: 'Admin' });
  assert.ok(!fs.existsSync(path.join(portal.data, 'private', 'setup-code')), 'setup code deleted');
  assert.strictEqual((await b.post('/studio/api/setup', { code: portal.setupCode, password: ADMIN_PASSWORD })).status, 409);
  assert.strictEqual((await b.get('/studio/api/status')).body.setupNeeded, false);
});

test('session cookie is HttpOnly, Secure, SameSite=Strict and scoped to /studio', async t => {
  const { admin } = await withAdmin(t);
  const r = await admin.post('/studio/api/admin/login', { password: ADMIN_PASSWORD });
  assert.match(r.setCookie, /HttpOnly/);
  assert.match(r.setCookie, /Secure/);
  assert.match(r.setCookie, /SameSite=Strict/);
  assert.match(r.setCookie, /Path=\/studio/);
});

test('admin sets a PIN; the artist logs in with it and sees only their own account', async t => {
  const { base, admin } = await withAdmin(t);
  const set = await admin.post('/studio/api/admin/artists/chris/pin', { pin: '482915' });
  assert.deepStrictEqual(set.body, { pin: '482915' });
  const random = await admin.post('/studio/api/admin/artists/dexter/pin', {});
  assert.match(random.body.pin, /^\d{6}$/);

  const chris = browser(base);
  const status = await chris.get('/studio/api/status');
  assert.deepStrictEqual(status.body.artists.map(a => [a.id, a.canLogin]), [['chris', true], ['dexter', true]]);
  assert.strictEqual(status.body.me, null);
  const r = await chris.post('/studio/api/login', { artist: 'chris', pin: '482915' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual((await chris.get('/studio/api/status')).body.me, { role: 'artist', id: 'chris', name: 'Chris' });
  assert.strictEqual((await chris.get('/studio/api/admin/artists')).status, 403, 'artists are not admins');
  assert.strictEqual((await chris.post('/studio/api/admin/artists/dexter/pin', {})).status, 403);
});

test('wrong PINs count down, then lock the artist out even with the right PIN', async t => {
  const { base, admin } = await withAdmin(t);
  await admin.post('/studio/api/admin/artists/chris/pin', { pin: '482915' });
  const b = browser(base);
  for (let left = 4; left >= 1; left--) {
    const r = await b.post('/studio/api/login', { artist: 'chris', pin: '000001' });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.body.triesLeft, left);
  }
  const locked = await b.post('/studio/api/login', { artist: 'chris', pin: '000001' });
  assert.strictEqual(locked.status, 429);
  assert.match(locked.body.error, /Try again in 15 minutes/);
  const right = await browser(base, '192.0.2.77').post('/studio/api/login', { artist: 'chris', pin: '482915' });
  assert.strictEqual(right.status, 429, 'locked from every device, right PIN or not');

  const list = (await admin.get('/studio/api/admin/artists')).body;
  assert.strictEqual(list.find(a => a.id === 'chris').lockedFor, '15 minutes');
  await admin.post('/studio/api/admin/artists/chris/unlock');
  assert.strictEqual((await browser(base, '192.0.2.77').post('/studio/api/login', { artist: 'chris', pin: '482915' })).status, 200);
});

test('a new PIN or "sign out everywhere" ends existing logins', async t => {
  const { base, admin } = await withAdmin(t);
  await admin.post('/studio/api/admin/artists/chris/pin', { pin: '482915' });
  const phone = browser(base);
  const laptop = browser(base);
  await phone.post('/studio/api/login', { artist: 'chris', pin: '482915' });
  await laptop.post('/studio/api/login', { artist: 'chris', pin: '482915' });
  assert.strictEqual((await admin.get('/studio/api/admin/artists')).body.find(a => a.id === 'chris').signedIn, 2);

  await phone.post('/studio/api/logout-everywhere');
  assert.strictEqual((await laptop.get('/studio/api/status')).body.me, null);

  await laptop.post('/studio/api/login', { artist: 'chris', pin: '482915' });
  await admin.post('/studio/api/admin/artists/chris/pin', { pin: '730264' });
  assert.strictEqual((await laptop.get('/studio/api/status')).body.me, null, 'new PIN signs the old login out');
  assert.strictEqual((await laptop.post('/studio/api/login', { artist: 'chris', pin: '482915' })).status, 401);

  await laptop.post('/studio/api/login', { artist: 'chris', pin: '730264' });
  await admin.post('/studio/api/admin/artists/chris/remove-pin');
  assert.strictEqual((await laptop.get('/studio/api/status')).body.me, null);
  assert.strictEqual((await laptop.post('/studio/api/login', { artist: 'chris', pin: '730264' })).status, 403);
});

test('log out ends only this login', async t => {
  const { base, admin } = await withAdmin(t);
  await admin.post('/studio/api/admin/artists/chris/pin', { pin: '482915' });
  const phone = browser(base);
  const laptop = browser(base);
  await phone.post('/studio/api/login', { artist: 'chris', pin: '482915' });
  await laptop.post('/studio/api/login', { artist: 'chris', pin: '482915' });
  await phone.post('/studio/api/logout');
  assert.strictEqual((await phone.get('/studio/api/status')).body.me, null);
  assert.ok((await laptop.get('/studio/api/status')).body.me);
});

test('requests from other sites or without JSON are refused', async t => {
  const { base, admin } = await withAdmin(t);
  await admin.post('/studio/api/admin/artists/chris/pin', { pin: '482915' });
  const b = browser(base);
  assert.strictEqual((await b.post('/studio/api/login', { artist: 'chris', pin: '482915' }, { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await b.post('/studio/api/login', { artist: 'chris', pin: '482915' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.strictEqual((await admin.post('/studio/api/admin/artists/chris/remove-pin', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.ok((await admin.get('/studio/api/admin/artists')).body.find(a => a.id === 'chris').hasPin, 'still has a PIN');
});

test('admin password: wrong ones lock too, and changing it signs other admin logins out', async t => {
  const { base, admin } = await withAdmin(t);
  const other = browser(base, '198.51.100.2');
  assert.strictEqual((await other.post('/studio/api/admin/login', { password: ADMIN_PASSWORD })).status, 200);
  assert.strictEqual((await admin.post('/studio/api/admin/password', { current: 'nope', password: 'a much longer new password' })).status, 401);
  const r = await admin.post('/studio/api/admin/password', { current: ADMIN_PASSWORD, password: 'a much longer new password' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await other.get('/studio/api/status')).body.me, null);
  assert.strictEqual((await admin.get('/studio/api/status')).body.me.role, 'admin', 'the one who changed it stays in');

  const guesser = browser(base, '192.0.2.9');
  for (let i = 0; i < 4; i++) await guesser.post('/studio/api/admin/login', { password: 'guess guess guess' + i });
  assert.strictEqual((await guesser.post('/studio/api/admin/login', { password: 'guess guess guess' })).status, 429);
});

test('no PINs or tokens are stored in plain text', async t => {
  const { base, admin, data } = await withAdmin(t);
  await admin.post('/studio/api/admin/artists/chris/pin', { pin: '482915' });
  const b = browser(base);
  await b.post('/studio/api/login', { artist: 'chris', pin: '482915' });
  const token = b.cookie.split('=')[1];
  for (const f of fs.readdirSync(path.join(data, 'private'))) {
    const text = fs.readFileSync(path.join(data, 'private', f), 'utf8');
    assert.ok(!text.includes('482915'), `${f} has the PIN`);
    assert.ok(!text.includes(ADMIN_PASSWORD), `${f} has the password`);
    assert.ok(!text.includes(token), `${f} has the session token`);
    assert.strictEqual(fs.statSync(path.join(data, 'private', f)).mode & 0o077, 0, `${f} is private`);
  }
});

test('unknown artists, bad JSON and huge bodies get clean errors', async t => {
  const { base } = await withAdmin(t);
  const b = browser(base);
  assert.strictEqual((await b.post('/studio/api/login', { artist: 'nobody', pin: '482915' })).status, 404);
  const bad = await fetch(base + '/studio/api/login', {
    method: 'POST', body: '{not json',
    headers: { Origin: 'https://borrowedtimetattoomckinney.com', 'X-Forwarded-Host': 'borrowedtimetattoomckinney.com', 'Content-Type': 'application/json' },
  });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual((await b.post('/studio/api/login', { artist: 'chris', pin: 'x'.repeat(20000) })).status, 413);
});
