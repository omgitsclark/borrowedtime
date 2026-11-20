// The live gallery list (gallery.json) and the changes artists can make to it.
//
// gallery.json holds every photo in artist-page order. A photo tagged with a studio style
// (studio.<style>) also shows in that shop gallery, in studio.<style>.order, with a reference
// code like "AN-D25" (style prefix, artist code, number) that customers quote when booking.
'use strict';

const fs = require('fs');
const path = require('path');
const { readJSON, writeJSON } = require('./store');

const KEEP_BACKUPS = 30;

class Gallery {
  constructor(file, backupDir = null, now = Date.now) {
    this.file = file;
    this.backupDir = backupDir;
    this.now = now;
  }

  read() {
    const g = readJSON(this.file, null);
    if (!g) throw new Error(`${this.file} is missing`);
    return g;
  }

  // Apache serves this file, so it's world-readable. The first change each day also keeps a
  // copy of the list as it was, so a mistake can be undone; the last 30 days are kept.
  write(g) {
    if (this.backupDir && fs.existsSync(this.file)) {
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const backup = path.join(this.backupDir, `gallery-${day}.json`);
      if (!fs.existsSync(backup)) {
        fs.mkdirSync(this.backupDir, { recursive: true });
        fs.copyFileSync(this.file, backup);
        const old = fs.readdirSync(this.backupDir).filter(f => /^gallery-\d{4}-\d\d-\d\d\.json$/.test(f)).sort();
        for (const f of old.slice(0, -KEEP_BACKUPS)) fs.rmSync(path.join(this.backupDir, f), { force: true });
      }
    }
    writeJSON(this.file, g, 0o644);
  }

  // Read, change and save in one step. Everything inside is synchronous, so two requests can't
  // interleave and lose each other's changes.
  change(fn) {
    const g = this.read();
    const result = fn(g);
    this.write(g);
    return result;
  }
}

class GalleryError extends Error {}

function artistPhotos(g, artistId) {
  return g.photos.filter(p => p.artist === artistId);
}

function findPhoto(g, id) {
  const photo = g.photos.find(p => p.id === id);
  if (!photo) throw new GalleryError('That photo is no longer in the gallery.');
  return photo;
}

function cleanTags(g, tags) {
  if (!Array.isArray(tags)) throw new GalleryError('Bad style list.');
  const known = new Set(g.tags.map(t => t.id));
  const out = [];
  for (const t of tags) {
    if (!known.has(t)) throw new GalleryError(`Unknown style "${t}".`);
    if (!out.includes(t)) out.push(t);
  }
  // Keep the site's style order so filters and saved data stay tidy.
  return g.tags.map(t => t.id).filter(t => out.includes(t));
}

// Next reference code for this artist in this studio gallery. Numbers are never reused, so a
// code a customer saved always means the same photo (or none).
function nextRef(g, styleId, artist) {
  const s = g.studio[styleId];
  s.lastRef = s.lastRef || {};
  let last = s.lastRef[artist.code];
  if (last == null) {
    const re = new RegExp(`^${s.prefix}-${artist.code}(\\d+)$`);
    last = 0;
    for (const p of g.photos) {
      const m = p.refs && p.refs[styleId] && p.refs[styleId].match(re);
      if (m) last = Math.max(last, Number(m[1]));
    }
  }
  s.lastRef[artist.code] = last + 1;
  return `${s.prefix}-${artist.code}${String(last + 1).padStart(2, '0')}`;
}

function addToStudio(g, photo, styleId) {
  const s = g.studio[styleId];
  if (!s.order.includes(photo.id)) s.order.push(photo.id);
  photo.refs = photo.refs || {};
  if (!photo.refs[styleId]) {
    const artist = g.artists.find(a => a.id === photo.artist);
    photo.refs[styleId] = nextRef(g, styleId, artist);
  }
}

function removeFromStudio(g, photo, styleId) {
  const s = g.studio[styleId];
  s.order = s.order.filter(id => id !== photo.id);
  if (photo.refs) {
    delete photo.refs[styleId];
    if (!Object.keys(photo.refs).length) delete photo.refs;
  }
}

function setTags(g, id, tags) {
  const photo = findPhoto(g, id);
  const next = cleanTags(g, tags);
  for (const styleId of Object.keys(g.studio)) {
    if (next.includes(styleId)) addToStudio(g, photo, styleId);
    else removeFromStudio(g, photo, styleId);
  }
  photo.tags = next;
  return photo;
}

// A new upload goes first on the artist's page and last in each studio gallery it's tagged for.
function addPhoto(g, { artist, file, tags }) {
  if (g.photos.some(p => p.id === file)) throw new GalleryError('That photo is already in the gallery.');
  const photo = { id: file, artist, file, tags: [] };
  const first = g.photos.findIndex(p => p.artist === artist);
  g.photos.splice(first < 0 ? g.photos.length : first, 0, photo);
  setTags(g, photo.id, tags || []);
  return photo;
}

// ids: every one of the artist's photo ids, in the new order. The artist's photos keep the
// same places in the overall list, so other artists' pages don't change.
function reorder(g, artistId, ids) {
  const mine = artistPhotos(g, artistId);
  if (!Array.isArray(ids) || ids.length !== mine.length || new Set(ids).size !== ids.length) {
    throw new GalleryError('The photo list changed. Reload and try again.');
  }
  const byId = new Map(mine.map(p => [p.id, p]));
  if (!ids.every(id => byId.has(id))) throw new GalleryError('The photo list changed. Reload and try again.');
  let i = 0;
  g.photos = g.photos.map(p => (p.artist === artistId ? byId.get(ids[i++]) : p));
}

function removePhoto(g, id) {
  const photo = findPhoto(g, id);
  g.photos = g.photos.filter(p => p !== photo);
  for (const styleId of Object.keys(g.studio)) removeFromStudio(g, photo, styleId);
  return photo;
}

module.exports = { Gallery, GalleryError, artistPhotos, findPhoto, cleanTags, setTags, addPhoto, reorder, removePhoto };
