'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway data folder and a site folder with a small gallery.json to start from.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-'));
  const site = path.join(root, 'site');
  fs.mkdirSync(path.join(site, 'data'), { recursive: true });
  fs.writeFileSync(path.join(site, 'data', 'gallery.json'), JSON.stringify({
    version: 1,
    artists: [{ id: 'chris', name: 'Chris', page: 'chris.html', code: 'C' }],
    tags: [], studio: {},
    photos: [{ id: 'chris/a.jpg', artist: 'chris', file: 'chris/a.jpg', tags: [] }],
  }));
  process.env.PORTAL_DATA_DIR = path.join(root, 'data');
  process.env.PORTAL_SITE_DIR = site;
  delete require.cache[require.resolve('../portal')];
  return { root, site, data: process.env.PORTAL_DATA_DIR, portal: require('../portal') };
}

async function get(server, p) {
  const r = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
  return { status: r.status, body: await r.json(), headers: r.headers };
}

test('first start copies the site gallery list and sets up the data folder', async () => {
  const { data, site, portal } = fixture();
  const server = await portal.start({ port: 0 });
  try {
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(data, 'gallery.json'))),
      JSON.parse(fs.readFileSync(path.join(site, 'data', 'gallery.json'))));
    for (const d of ['uploads', 'thumbs', 'backups', 'private']) assert.ok(fs.statSync(path.join(data, d)).isDirectory(), d);
    assert.strictEqual(fs.statSync(path.join(data, 'private')).mode & 0o777, 0o700, 'private folder is owner-only');
    const r = await get(server, '/studio/api/health');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.body, { ok: true, photos: 1, artists: 1 });
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  } finally {
    server.close();
  }
});

test('later starts keep the live gallery list, not the repo copy', async () => {
  const { data, site, portal } = fixture();
  (await portal.start({ port: 0 })).close();
  const live = JSON.parse(fs.readFileSync(path.join(data, 'gallery.json')));
  live.photos = [];
  fs.writeFileSync(path.join(data, 'gallery.json'), JSON.stringify(live));
  fs.writeFileSync(path.join(site, 'data', 'gallery.json'), '{"changed": true}');
  const server = await portal.start({ port: 0 });
  try {
    assert.strictEqual((await get(server, '/studio/api/health')).body.photos, 0);
  } finally {
    server.close();
  }
});

test('unknown paths are 404', async () => {
  const { portal } = fixture();
  const server = await portal.start({ port: 0 });
  try {
    assert.strictEqual((await get(server, '/studio/api/nope')).status, 404);
  } finally {
    server.close();
  }
});

test('a broken site gallery list stops the first start instead of being copied', async () => {
  const { site, portal } = fixture();
  fs.writeFileSync(path.join(site, 'data', 'gallery.json'), '{broken');
  await assert.rejects(portal.start({ port: 0 }));
});
