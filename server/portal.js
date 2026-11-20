// Artist portal service: artists log in with a PIN and manage their gallery photos.
// Runs under systemd (borrowedtime-portal.service) on 127.0.0.1; Apache passes /studio/api/ to it.
//
// Everything it writes lives in DATA_DIR (/var/lib/borrowedtime), outside the git checkout so
// the auto-deploy's `git pull` never touches it:
//   gallery.json        the live gallery list (Apache serves it as /data/gallery.json)
//   uploads/<artist>/   uploaded photos (served as /images/uploads/...)
//   thumbs/<artist>/    their thumbnails (served as /images/thumbs/uploads/...)
//   private/            PIN and password hashes, sessions, login lockouts; never served
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Lockout } = require('./lib/lockout');
const { Accounts, Sessions, pinProblem, randomPin, passwordProblem } = require('./lib/auth');

const PORT = Number(process.env.PORT) || 8800;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.PORTAL_DATA_DIR || '/var/lib/borrowedtime';
const SITE_DIR = process.env.PORTAL_SITE_DIR || path.join(__dirname, '..');

const GALLERY = path.join(DATA_DIR, 'gallery.json');
const PRIVATE = path.join(DATA_DIR, 'private');
const SETUP_CODE = path.join(PRIVATE, 'setup-code');
const COOKIE = 'bt_session';
const WRONG_DELAY = 400; // ms; slows down scripted guessing a little more

function setup() {
  for (const dir of ['uploads', 'thumbs', 'backups']) fs.mkdirSync(path.join(DATA_DIR, dir), { recursive: true });
  fs.mkdirSync(PRIVATE, { recursive: true, mode: 0o700 });
  fs.chmodSync(PRIVATE, 0o700);
  // First start: the site's copy of the gallery list becomes the live one. After that the
  // portal owns it, and the copy in the repo is only this starting point.
  if (!fs.existsSync(GALLERY)) {
    const seed = path.join(SITE_DIR, 'data', 'gallery.json');
    JSON.parse(fs.readFileSync(seed, 'utf8')); // refuse to start from a broken file
    fs.copyFileSync(seed, GALLERY);
    console.log(`portal: created ${GALLERY} from ${seed}`);
  }
}

function readGallery() {
  return JSON.parse(fs.readFileSync(GALLERY, 'utf8'));
}

// Until the admin password is set, a one-time code in private/setup-code (readable only on the
// server: `sudo cat /var/lib/borrowedtime/private/setup-code`) is needed to set it.
function ensureSetupCode(accounts) {
  if (accounts.hasAdmin()) {
    fs.rmSync(SETUP_CODE, { force: true });
  } else if (!fs.existsSync(SETUP_CODE)) {
    fs.writeFileSync(SETUP_CODE, crypto.randomBytes(9).toString('base64url') + '\n', { mode: 0o600 });
    console.log(`portal: no admin password yet; setup code written to ${SETUP_CODE}`);
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function readBody(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        // Answer once the rest has arrived (and is thrown away), so the browser gets the message.
        req.removeAllListeners('data');
        req.resume();
        req.once('end', () => reject(new HttpError(413, 'Too much data.')));
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      if (size > limit) return;
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Bad request.'));
      }
    });
    req.on('error', reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/studio; Max-Age=${Math.floor(maxAge / 1000)}; HttpOnly; Secure; SameSite=Strict`;
}
const CLEAR_COOKIE = `${COOKIE}=; Path=/studio; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

// Apache adds the visitor's address as the last X-Forwarded-For entry; the service only
// listens on 127.0.0.1, so that header can be trusted.
function clientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return fwd.length ? fwd[fwd.length - 1] : req.socket.remoteAddress;
}

// Changes must come from the portal page itself, never from another site.
function checkSameSite(req) {
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  let origin = null;
  try { origin = new URL(req.headers.origin).host; } catch { /* missing or malformed */ }
  if (!origin || origin !== host) throw new HttpError(403, 'Not allowed.');
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Not allowed.');
}

function waitText(ms) {
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function lockedError(check) {
  const why = check.reason === 'ip' ? 'Too many wrong tries from this device.' : 'Too many wrong tries.';
  return new HttpError(429, `${why} Try again in ${waitText(check.retryAfter)}.`, { retryAfter: Math.ceil(check.retryAfter / 1000) });
}

const delay = ms => new Promise(r => setTimeout(r, ms));

function createApp() {
  setup();
  const lockout = new Lockout({ file: path.join(PRIVATE, 'lockout.json') });
  const accounts = new Accounts(PRIVATE);
  const sessions = new Sessions(PRIVATE);
  ensureSetupCode(accounts);

  function me(req) {
    const account = sessions.account(cookies(req)[COOKIE]);
    if (!account) return null;
    if (account === 'admin') return { role: 'admin', name: 'Admin' };
    const id = account.slice('artist:'.length);
    const artist = readGallery().artists.find(a => a.id === id);
    if (!artist || !accounts.hasPin(id)) return null;
    return { role: 'artist', id, name: artist.name };
  }

  function requireAdmin(req) {
    const who = me(req);
    if (!who) throw new HttpError(401, 'Please log in.');
    if (who.role !== 'admin') throw new HttpError(403, 'Only the admin can do that.');
  }

  function findArtist(id) {
    const artist = readGallery().artists.find(a => a.id === id);
    if (!artist) throw new HttpError(404, 'No such artist.');
    return artist;
  }

  function logIn(res, account, body) {
    lockout.succeed(account);
    const { token, maxAge } = sessions.create(account);
    send(res, 200, body, { 'Set-Cookie': sessionCookie(token, maxAge) });
  }

  // Runs check() for a PIN or password with the lockout rules around it.
  async function guarded(account, ip, check) {
    const before = lockout.check(account, ip);
    if (!before.ok) throw lockedError(before);
    if (await check()) return;
    const after = lockout.fail(account, ip);
    await delay(WRONG_DELAY);
    if (!after.ok) throw lockedError(after);
    const left = lockout.triesLeft(account);
    throw new HttpError(401, `That's not right. ${left} ${left === 1 ? 'try' : 'tries'} left before a lockout.`, { triesLeft: left });
  }

  const routes = {
    'GET /studio/api/health': () => {
      const g = readGallery();
      return { ok: true, photos: g.photos.length, artists: g.artists.length };
    },

    // What the login page needs: who can log in, whether setup is still needed, and who you are.
    'GET /studio/api/status': req => ({
      setupNeeded: !accounts.hasAdmin(),
      artists: readGallery().artists.map(a => ({ id: a.id, name: a.name, canLogin: accounts.hasPin(a.id) })),
      me: me(req),
    }),

    'POST /studio/api/setup': async (req, res, body) => {
      if (accounts.hasAdmin()) throw new HttpError(409, 'The admin password is already set.');
      const problem = passwordProblem(body.password);
      if (problem) throw new HttpError(400, problem);
      const expected = fs.readFileSync(SETUP_CODE, 'utf8').trim();
      await guarded('setup', clientIp(req), async () => {
        const a = Buffer.from(String(body.code || '').trim());
        const b = Buffer.from(expected);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
      });
      await accounts.setAdmin(body.password);
      ensureSetupCode(accounts);
      console.log(`portal: admin password set (from ${clientIp(req)})`);
      logIn(res, 'admin', { me: { role: 'admin', name: 'Admin' } });
    },

    'POST /studio/api/login': async (req, res, body) => {
      const artist = findArtist(String(body.artist || ''));
      if (!accounts.hasPin(artist.id)) throw new HttpError(403, `${artist.name} doesn't have a PIN yet. Ask the shop for one.`);
      const account = `artist:${artist.id}`;
      await guarded(account, clientIp(req), () => accounts.checkPin(artist.id, String(body.pin || '')));
      logIn(res, account, { me: { role: 'artist', id: artist.id, name: artist.name } });
    },

    'POST /studio/api/admin/login': async (req, res, body) => {
      if (!accounts.hasAdmin()) throw new HttpError(409, 'Set the admin password first.');
      await guarded('admin', clientIp(req), () => accounts.checkAdmin(String(body.password || '')));
      logIn(res, 'admin', { me: { role: 'admin', name: 'Admin' } });
    },

    'POST /studio/api/logout': (req, res) => {
      const token = cookies(req)[COOKIE];
      if (token) sessions.end(token);
      send(res, 200, { ok: true }, { 'Set-Cookie': CLEAR_COOKIE });
    },

    'POST /studio/api/logout-everywhere': (req, res) => {
      const account = sessions.account(cookies(req)[COOKIE]);
      if (!account) throw new HttpError(401, 'Please log in.');
      sessions.endAll(account);
      send(res, 200, { ok: true }, { 'Set-Cookie': CLEAR_COOKIE });
    },

    'GET /studio/api/admin/artists': req => {
      requireAdmin(req);
      const g = readGallery();
      return g.artists.map(a => {
        const lock = lockout.check(`artist:${a.id}`, '');
        return {
          id: a.id,
          name: a.name,
          hasPin: accounts.hasPin(a.id),
          lockedFor: lock.ok ? null : waitText(lock.retryAfter),
          signedIn: sessions.count(`artist:${a.id}`),
          photos: g.photos.filter(p => p.artist === a.id).length,
        };
      });
    },

    'POST /studio/api/admin/password': async (req, res, body) => {
      requireAdmin(req);
      const problem = passwordProblem(body.password);
      if (problem) throw new HttpError(400, problem);
      await guarded('admin', clientIp(req), () => accounts.checkAdmin(String(body.current || '')));
      await accounts.setAdmin(body.password);
      sessions.endAll('admin');
      logIn(res, 'admin', { ok: true });
    },
  };

  // Per-artist admin actions: POST /studio/api/admin/artists/<id>/<action>
  const artistActions = {
    // Set a PIN (the admin's choice, or a random one). Signs the artist out everywhere.
    async pin(artist, body) {
      const pin = body.pin ? String(body.pin) : randomPin();
      const problem = pinProblem(pin);
      if (problem) throw new HttpError(400, problem);
      await accounts.setPin(artist.id, pin);
      sessions.endAll(`artist:${artist.id}`);
      lockout.unlock(`artist:${artist.id}`);
      console.log(`portal: admin set a new PIN for ${artist.id}`);
      return { pin };
    },
    'remove-pin'(artist) {
      accounts.removePin(artist.id);
      sessions.endAll(`artist:${artist.id}`);
      console.log(`portal: admin removed ${artist.id}'s login`);
      return { ok: true };
    },
    unlock(artist) {
      lockout.unlock(`artist:${artist.id}`);
      return { ok: true };
    },
    'sign-out'(artist) {
      sessions.endAll(`artist:${artist.id}`);
      return { ok: true };
    },
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://portal');
    const key = `${req.method} ${url.pathname}`;
    const action = url.pathname.match(/^\/studio\/api\/admin\/artists\/([a-z0-9-]+)\/([a-z-]+)$/);
    const route = routes[key] || (req.method === 'POST' && action && artistActions[action[2]]
      ? async (rq, rs, body) => { requireAdmin(rq); return artistActions[action[2]](findArtist(action[1]), body); }
      : null);
    if (!route) throw new HttpError(404, 'Not found.');
    let body = {};
    if (req.method === 'POST') {
      checkSameSite(req);
      body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Bad request.');
    }
    const result = await route(req, res, body);
    if (!res.headersSent) send(res, 200, result);
  }

  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) send(res, err.status, { error: err.message, ...err.extra });
      } else {
        console.error(`portal: ${req.method} ${req.url} failed: ${err.stack}`);
        if (!res.headersSent) send(res, 500, { error: 'Something went wrong. Please try again.' });
      }
    }
  };
}

async function start({ port = PORT, host = HOST } = {}) {
  const server = http.createServer(createApp());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`portal: listening on ${host}:${server.address().port}, data in ${DATA_DIR}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().catch(err => {
    console.error(`portal: could not start: ${err.stack}`);
    process.exit(1);
  });
}

module.exports = { start };
