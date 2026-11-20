'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const G = require('../lib/gallery');

const HOST = 'borrowedtimetattoomckinney.com';

function seedGallery() {
  return {
    version: 1,
    artists: [
      { id: 'chris', name: 'Chris', page: 'chris.html', code: 'C' },
      { id: 'dexter', name: 'Dexter', page: 'dexter.html', code: 'D' },
    ],
    tags: [{ id: 'animals', label: 'Animals' }, { id: 'color', label: 'Color' }, { id: 'coverups', label: 'Coverups' }],
    studio: {
      animals: { label: 'Animals', prefix: 'AN', order: ['chris/wolf.jpg', 'dexter/shark.jpg'] },
      color: { label: 'Color', prefix: 'CO', order: [] },
    },
    photos: [
      { id: 'dexter/shark.jpg', artist: 'dexter', file: 'dexter/shark.jpg', tags: ['animals'], refs: { animals: 'AN-D07' } },
      { id: 'chris/wolf.jpg', artist: 'chris', file: 'chris/wolf.jpg', tags: ['animals'], refs: { animals: 'AN-C03' } },
      { id: 'dexter/rose.jpg', artist: 'dexter', file: 'dexter/rose.jpg', tags: [] },
      { id: 'chris/lion.jpg', artist: 'chris', file: 'chris/lion.jpg', tags: [] },
    ],
  };
}

test('gallery changes: new photos, styles, codes, order, delete', () => {
  const g = seedGallery();
  const p = G.addPhoto(g, { artist: 'chris', file: 'uploads/chris/new.jpg', tags: ['color', 'animals'] });
  // First on Chris's page; other artists keep their places.
  assert.deepStrictEqual(g.photos.map(x => x.id), ['dexter/shark.jpg', 'uploads/chris/new.jpg', 'chris/wolf.jpg', 'dexter/rose.jpg', 'chris/lion.jpg']);
  assert.deepStrictEqual(p.tags, ['animals', 'color']);
  assert.deepStrictEqual(p.refs, { animals: 'AN-C04', color: 'CO-C01' });
  assert.deepStrictEqual(g.studio.animals.order, ['chris/wolf.jpg', 'dexter/shark.jpg', 'uploads/chris/new.jpg']);

  // Removing a style takes it out of that gallery; adding it back gives a new code, never an old one.
  G.setTags(g, p.id, ['color']);
  assert.ok(!g.studio.animals.order.includes(p.id));
  assert.deepStrictEqual(p.refs, { color: 'CO-C01' });
  G.setTags(g, p.id, ['color', 'animals', 'coverups']);
  assert.strictEqual(p.refs.animals, 'AN-C05');
  assert.throws(() => G.setTags(g, p.id, ['nope']), G.GalleryError);

  G.reorder(g, 'chris', ['chris/lion.jpg', 'uploads/chris/new.jpg', 'chris/wolf.jpg']);
  assert.deepStrictEqual(g.photos.map(x => x.id), ['dexter/shark.jpg', 'chris/lion.jpg', 'uploads/chris/new.jpg', 'dexter/rose.jpg', 'chris/wolf.jpg']);
  assert.throws(() => G.reorder(g, 'chris', ['chris/lion.jpg', 'chris/wolf.jpg']), G.GalleryError);
  assert.throws(() => G.reorder(g, 'chris', ['chris/lion.jpg', 'chris/wolf.jpg', 'dexter/rose.jpg']), G.GalleryError);

  G.removePhoto(g, 'chris/wolf.jpg');
  assert.ok(!g.photos.some(x => x.id === 'chris/wolf.jpg'));
  assert.deepStrictEqual(g.studio.animals.order, ['dexter/shark.jpg', 'uploads/chris/new.jpg']);
  const again = G.addPhoto(g, { artist: 'chris', file: 'uploads/chris/b.jpg', tags: ['animals'] });
  assert.strictEqual(again.refs.animals, 'AN-C06');
});

async function startPortal() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-photos-'));
  const site = path.join(root, 'site');
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site, 'data', 'gallery.json'), JSON.stringify(seedGallery()));
  process.env.PORTAL_DATA_DIR = path.join(root, 'data');
  process.env.PORTAL_SITE_DIR = site;
  delete require.cache[require.resolve('../portal')];
  const server = await require('../portal').start({ port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  const data = path.join(root, 'data');
  const setupCode = fs.readFileSync(path.join(data, 'private', 'setup-code'), 'utf8').trim();
  return { server, base, data, setupCode };
}

function browser(base, ip) {
  let cookie = null;
  const call = async (method, p, body, headers = {}) => {
    headers = { 'X-Forwarded-For': ip, 'X-Forwarded-Host': HOST, ...headers };
    if (method === 'POST') {
      headers.Origin = headers.Origin || `https://${HOST}`;
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    }
    if (cookie) headers.Cookie = cookie;
    const raw = Buffer.isBuffer(body);
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const set = r.headers.get('set-cookie');
    if (set) cookie = /Max-Age=0/.test(set) ? null : set.split(';')[0];
    return { status: r.status, body: await r.json() };
  };
  return {
    get: p => call('GET', p),
    post: (p, body = {}, headers) => call('POST', p, body, headers),
    upload: (p, buf, type = 'image/jpeg', headers = {}) => call('POST', p, buf, { 'Content-Type': type, ...headers }),
  };
}

// The shop's portal with an admin and two artists logged in.
async function withPortal(t) {
  const portal = await startPortal();
  t.after(() => portal.server.close());
  const admin = browser(portal.base, '198.51.100.1');
  assert.strictEqual((await admin.post('/studio/api/setup', { code: portal.setupCode, password: 'correct horse battery' })).status, 200);
  const artists = {};
  for (const id of ['chris', 'dexter']) {
    const { body } = await admin.post(`/studio/api/admin/artists/${id}/pin`);
    artists[id] = browser(portal.base, `203.0.113.${id.length}`);
    assert.strictEqual((await artists[id].post('/studio/api/login', { artist: id, pin: body.pin })).status, 200);
  }
  const live = () => JSON.parse(fs.readFileSync(path.join(portal.data, 'gallery.json'), 'utf8'));
  return { ...portal, admin, ...artists, live };
}

// A sideways phone photo: 3000x2000 pixels stored, tagged "rotate 90°", with a GPS location.
function phonePhoto() {
  return sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#a03020' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '33/1 11/1 0/1' } })
    .toBuffer();
}

test('an artist uploads a phone photo: upright, shrunk, no location, first on their page', async t => {
  const { chris, data, live } = await withPortal(t);
  const r = await chris.upload('/studio/api/photos/upload?tags=animals,color', await phonePhoto());
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const photo = r.body.photos[0];
  assert.match(photo.file, /^uploads\/chris\/\d{4}-\d\d-\d\d-[0-9a-f]{10}\.jpg$/);
  assert.deepStrictEqual(photo.refs, { animals: 'AN-C04', color: 'CO-C01' });
  assert.deepStrictEqual(r.body.photos.map(p => p.id).slice(1), ['chris/wolf.jpg', 'chris/lion.jpg']);

  const full = await sharp(path.join(data, photo.file)).metadata();
  assert.deepStrictEqual([full.width, full.height], [1333, 2000]); // turned upright, long side 2000
  assert.strictEqual(full.exif, undefined);
  assert.ok(!full.orientation || full.orientation === 1);
  const thumb = await sharp(path.join(data, 'thumbs', photo.file.slice('uploads/'.length))).metadata();
  assert.deepStrictEqual([thumb.width, thumb.height], [720, 720]);

  const g = live();
  assert.ok(g.studio.animals.order.includes(photo.id));
  assert.strictEqual(fs.statSync(path.join(data, 'gallery.json')).mode & 0o777, 0o644);
  assert.strictEqual(fs.statSync(path.join(data, photo.file)).mode & 0o777, 0o644);
  assert.ok(fs.readdirSync(path.join(data, 'backups')).some(f => /^gallery-\d{4}-\d\d-\d\d\.json$/.test(f)));
});

test('uploads are refused unless they come from a logged-in artist on the portal page', async t => {
  const { chris, base } = await withPortal(t);
  const img = await phonePhoto();
  const stranger = browser(base, '192.0.2.9');
  assert.strictEqual((await stranger.upload('/studio/api/photos/upload', img)).status, 401);
  assert.strictEqual((await chris.upload('/studio/api/photos/upload', img, 'image/jpeg', { Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await chris.upload('/studio/api/photos/upload', img, 'text/plain')).status, 415);
  assert.strictEqual((await chris.upload('/studio/api/photos/upload?artist=dexter', img)).status, 403);
  const junk = await chris.upload('/studio/api/photos/upload', Buffer.from('not a photo at all'));
  assert.strictEqual(junk.status, 400);
  assert.match(junk.body.error, /isn't a photo/);
  const tiny = await chris.upload('/studio/api/photos/upload', await sharp({ create: { width: 50, height: 50, channels: 3, background: '#000' } }).png().toBuffer(), 'image/png');
  assert.strictEqual(tiny.status, 400);
  const badTag = await chris.upload('/studio/api/photos/upload?tags=nope', img);
  assert.strictEqual(badTag.status, 400);
  assert.strictEqual((await chris.get('/studio/api/photos')).body.photos.length, 2);
});

test('artists can only change their own photos; the admin can change anyone\'s', async t => {
  const { chris, dexter, admin } = await withPortal(t);
  assert.strictEqual((await chris.post('/studio/api/photos/tags', { id: 'dexter/rose.jpg', tags: ['color'] })).status, 403);
  assert.strictEqual((await chris.post('/studio/api/photos/delete', { id: 'dexter/rose.jpg' })).status, 403);
  assert.strictEqual((await chris.post('/studio/api/photos/order', { artist: 'dexter', ids: ['dexter/rose.jpg', 'dexter/shark.jpg'] })).status, 403);
  assert.strictEqual((await chris.get('/studio/api/photos?artist=dexter')).status, 403);

  const mine = await dexter.get('/studio/api/photos');
  assert.deepStrictEqual(mine.body.photos.map(p => p.id), ['dexter/shark.jpg', 'dexter/rose.jpg']);
  const viaAdmin = await admin.get('/studio/api/photos?artist=dexter');
  assert.deepStrictEqual(viaAdmin.body, mine.body);
  const tagged = await admin.post('/studio/api/photos/tags', { id: 'dexter/rose.jpg', tags: ['color'] });
  assert.strictEqual(tagged.body.photos[1].refs.color, 'CO-D01');
  assert.strictEqual((await admin.get('/studio/api/photos')).status, 404);
});

test('reorder, before photos and delete', async t => {
  const { chris, data, live } = await withPortal(t);
  const up = await chris.upload('/studio/api/photos/upload?tags=animals', await phonePhoto());
  const id = up.body.photos[0].id;

  const moved = await chris.post('/studio/api/photos/order', { ids: ['chris/wolf.jpg', 'chris/lion.jpg', id] });
  assert.deepStrictEqual(moved.body.photos.map(p => p.id), ['chris/wolf.jpg', 'chris/lion.jpg', id]);
  assert.deepStrictEqual(live().photos.map(p => p.artist), ['dexter', 'chris', 'chris', 'dexter', 'chris']);

  const before = await chris.upload(`/studio/api/photos/before?id=${encodeURIComponent(id)}`, await phonePhoto());
  const withBefore = before.body.photos.find(p => p.id === id);
  assert.match(withBefore.before, /^uploads\/chris\/.*-before\.jpg$/);
  assert.ok(fs.existsSync(path.join(data, withBefore.before)));
  await chris.post('/studio/api/photos/remove-before', { id });
  assert.strictEqual(live().photos.find(p => p.id === id).before, undefined);
  assert.ok(!fs.existsSync(path.join(data, withBefore.before)));

  const gone = await chris.post('/studio/api/photos/delete', { id });
  assert.deepStrictEqual(gone.body.photos.map(p => p.id), ['chris/wolf.jpg', 'chris/lion.jpg']);
  assert.ok(!live().studio.animals.order.includes(id));
  assert.ok(!fs.existsSync(path.join(data, id)));
  assert.strictEqual(fs.readdirSync(path.join(data, 'deleted')).length, 3); // photo, thumbnail, before shot
  assert.strictEqual((await chris.post('/studio/api/photos/delete', { id })).status, 400);

  // A photo from the repo leaves the gallery; its file stays in the checkout.
  assert.strictEqual((await chris.post('/studio/api/photos/delete', { id: 'chris/lion.jpg' })).status, 200);
  assert.strictEqual(live().photos.filter(p => p.artist === 'chris').length, 1);
});
