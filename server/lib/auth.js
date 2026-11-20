// PINs, the admin password and login sessions.
//
// accounts.json: { admin: <secret>, artists: { <id>: <secret> } }, where a secret is the scrypt
//   hash of a PIN or password, never the PIN itself.
// sessions.json: { <sha256 of the session token>: { account, expires } }. The browser holds the
//   token in an HttpOnly cookie; the file holds only its hash, so a copy of the file can't log in.
'use strict';

const crypto = require('crypto');
const path = require('path');
const { readJSON, writeJSON } = require('./store');

const DAY = 24 * 60 * 60 * 1000;
const SESSION_LENGTH = { artist: 30 * DAY, admin: 12 * 60 * 60 * 1000 };

function scrypt(secret, salt) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(secret, salt, 32, { N: 16384, r: 8, p: 1 }, (err, key) => (err ? reject(err) : resolve(key))));
}

async function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('base64'), hash: (await scrypt(secret, salt)).toString('base64') };
}

async function checkSecret(secret, stored) {
  if (!stored) {
    await scrypt(secret, 'no-account'); // take the same time either way
    return false;
  }
  const key = await scrypt(secret, Buffer.from(stored.salt, 'base64'));
  return crypto.timingSafeEqual(key, Buffer.from(stored.hash, 'base64'));
}

// PINs: exactly 6 digits, and not one anybody would try first.
function pinProblem(pin) {
  if (!/^\d{6}$/.test(pin)) return 'A PIN is exactly 6 digits.';
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((n, i) => n - d[i]);
  if (new Set(d).size <= 2) return 'That PIN is too easy to guess. Use more different digits.';
  if (steps.every(s => s === 1) || steps.every(s => s === -1)) return 'That PIN is too easy to guess (a run like 123456).';
  if (pin.slice(0, 3) === pin.slice(3) || pin.slice(0, 2).repeat(3) === pin) return 'That PIN is too easy to guess (it repeats).';
  return null;
}

function randomPin() {
  for (;;) {
    const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!pinProblem(pin)) return pin;
  }
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 12) return 'The admin password needs at least 12 characters.';
  if (password.length > 200) return 'That password is too long.';
  return null;
}

class Accounts {
  constructor(dir) {
    this.file = path.join(dir, 'accounts.json');
    this.data = readJSON(this.file, { admin: null, artists: {} });
  }
  save() { writeJSON(this.file, this.data); }
  hasAdmin() { return Boolean(this.data.admin); }
  hasPin(artist) { return Boolean(this.data.artists[artist]); }
  checkAdmin(password) { return checkSecret(password, this.data.admin); }
  checkPin(artist, pin) { return checkSecret(pin, this.data.artists[artist]); }
  async setAdmin(password) { this.data.admin = await hashSecret(password); this.save(); }
  async setPin(artist, pin) { this.data.artists[artist] = await hashSecret(pin); this.save(); }
  removePin(artist) { delete this.data.artists[artist]; this.save(); }
}

class Sessions {
  constructor(dir, now = Date.now) {
    this.file = path.join(dir, 'sessions.json');
    this.now = now;
    this.data = readJSON(this.file, {});
  }

  static key(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }

  // account is 'admin' or 'artist:<id>'. Returns the token for the cookie and how long it lasts.
  create(account) {
    const token = crypto.randomBytes(32).toString('base64url');
    const maxAge = account === 'admin' ? SESSION_LENGTH.admin : SESSION_LENGTH.artist;
    this.data[Sessions.key(token)] = { account, expires: this.now() + maxAge };
    this.prune();
    this.save();
    return { token, maxAge };
  }

  account(token) {
    if (!token) return null;
    const s = this.data[Sessions.key(token)];
    return s && s.expires > this.now() ? s.account : null;
  }

  end(token) {
    delete this.data[Sessions.key(token)];
    this.save();
  }

  // Sign an account out everywhere (new PIN, removed login, "sign out everywhere").
  endAll(account) {
    for (const [k, s] of Object.entries(this.data)) if (s.account === account) delete this.data[k];
    this.save();
  }

  count(account) {
    return Object.values(this.data).filter(s => s.account === account && s.expires > this.now()).length;
  }

  prune() {
    for (const [k, s] of Object.entries(this.data)) if (s.expires <= this.now()) delete this.data[k];
  }

  save() { writeJSON(this.file, this.data); }
}

module.exports = { Accounts, Sessions, pinProblem, randomPin, passwordProblem };
