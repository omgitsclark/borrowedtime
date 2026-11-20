// Artist portal service: artists log in with a PIN and manage their gallery photos.
// Runs under systemd (borrowedtime-portal.service) on 127.0.0.1; Apache passes /studio/api/ to it.
//
// Everything it writes lives in DATA_DIR (/var/lib/borrowedtime), outside the git checkout so
// the auto-deploy's `git pull` never touches it:
//   gallery.json        the live gallery list (Apache serves it as /data/gallery.json)
//   uploads/<artist>/   uploaded photos (served as /images/uploads/...)
//   thumbs/<artist>/    their thumbnails (served as /images/thumbs/uploads/...)
//   private/            PIN hashes, login lockouts; never served
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { Lockout } = require('./lib/lockout');

const PORT = Number(process.env.PORT) || 8800;
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.PORTAL_DATA_DIR || '/var/lib/borrowedtime';
const SITE_DIR = process.env.PORTAL_SITE_DIR || path.join(__dirname, '..');

const GALLERY = path.join(DATA_DIR, 'gallery.json');
const PRIVATE = path.join(DATA_DIR, 'private');

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

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(json);
}

function handle(req, res) {
  const url = new URL(req.url, 'http://portal');
  if (req.method === 'GET' && url.pathname === '/studio/api/health') {
    const gallery = readGallery();
    return send(res, 200, { ok: true, photos: gallery.photos.length, artists: gallery.artists.length });
  }
  send(res, 404, { error: 'Not found' });
}

async function start({ port = PORT, host = HOST } = {}) {
  setup();
  const lockout = new Lockout({ file: path.join(PRIVATE, 'lockout.json') });
  const server = http.createServer((req, res) => {
    try {
      handle(req, res, { lockout });
    } catch (err) {
      console.error(`portal: ${req.method} ${req.url} failed: ${err.stack}`);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong' });
    }
  });
  return new Promise(resolve => server.listen(port, host, () => {
    console.log(`portal: listening on ${host}:${server.address().port}, data in ${DATA_DIR}`);
    resolve(server);
  }));
}

if (require.main === module) {
  start().catch(err => {
    console.error(`portal: could not start: ${err.stack}`);
    process.exit(1);
  });
}

module.exports = { start };
