// Turns an uploaded phone photo into the two files the site serves: a full-size JPEG (at most
// 2000 px on its long side) and a 720 px square thumbnail for the grid, matching what
// tools/make_thumbnails.py makes for photos in the repo. The photo is turned upright, and its
// metadata (GPS location, camera details) is dropped. The portal page already shrinks photos
// and converts iPhone HEIC to JPEG before sending; this handles whatever arrives.
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

// One photo at a time keeps memory low on the small server.
sharp.concurrency(1);
sharp.cache(false);

const FULL = 2000;
const THUMB = 720;
const MAX_PIXELS = 100e6;

class ImageError extends Error {}

let queue = Promise.resolve();
function oneAtATime(work) {
  const run = queue.then(work, work);
  queue = run.catch(() => {});
  return run;
}

function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

async function convert(buf) {
  let meta;
  try {
    meta = await sharp(buf, { limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new ImageError("That file isn't a photo the site can use. Try a JPEG or PNG.");
  }
  const { width, height } = meta.autoOrient || meta;
  if (!width || !height) throw new ImageError("That file isn't a photo the site can use. Try a JPEG or PNG.");
  if (width < 200 || height < 200) throw new ImageError('That photo is too small to show on the site.');

  const input = () => sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).rotate();
  try {
    const full = await input()
      .resize({ width: FULL, height: FULL, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    const side = Math.min(THUMB, width, height);
    const thumb = await input()
      .resize({ width: side, height: side, fit: 'cover', position: 'centre' })
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();
    return { full, thumb };
  } catch {
    throw new ImageError("That photo couldn't be read. It may be damaged; try exporting it again.");
  }
}

// Saves the full-size photo to fullPath and, if thumbPath is given, its thumbnail there.
function savePhoto(buf, fullPath, thumbPath = null) {
  return oneAtATime(async () => {
    const { full, thumb } = await convert(buf);
    writeAtomic(fullPath, full);
    if (thumbPath) writeAtomic(thumbPath, thumb);
  });
}

module.exports = { savePhoto, ImageError };
