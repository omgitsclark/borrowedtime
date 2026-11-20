// Small JSON files on disk, written so a crash mid-write never leaves a half-written file.
'use strict';

const fs = require('fs');
const path = require('path');

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// mode 0o600 for private files; 0o644 for files Apache serves.
function writeJSON(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n', { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

module.exports = { readJSON, writeJSON };
