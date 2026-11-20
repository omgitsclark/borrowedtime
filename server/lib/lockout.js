// Limits PIN guesses so nobody can try PINs until one works.
//
// Per account (an artist, or the admin): 5 wrong PINs lock that login for 15 minutes; each
// lockout after that doubles (30 min, 1 h, ... up to 24 h), and a day with no lockout starts
// the doubling over. Per IP: 10 wrong PINs within 15 minutes, against any accounts, block that
// IP for an hour. While an account or IP is locked the caller must not check the PIN at all.
// State is saved to a JSON file so a restart doesn't clear it.
'use strict';

const fs = require('fs');
const { writeJSON } = require('./store');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const DEFAULTS = {
  accountTries: 5,        // wrong PINs before an account locks
  firstLock: 15 * MINUTE, // first lockout; doubles each time
  maxLock: 24 * HOUR,
  forgetAfter: 24 * HOUR, // a lockout-free day resets the doubling
  ipTries: 10,            // wrong PINs from one IP...
  ipWindow: 15 * MINUTE,  // ...within this long
  ipLock: HOUR,           // block that IP this long
};

class Lockout {
  constructor({ file = null, now = Date.now, ...limits } = {}) {
    this.file = file;
    this.now = now;
    this.limits = { ...DEFAULTS, ...limits };
    this.state = { accounts: {}, ips: {} };
    if (file && fs.existsSync(file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        this.state = { accounts: saved.accounts || {}, ips: saved.ips || {} };
      } catch (err) {
        console.error(`lockout: could not read ${file}, starting empty: ${err.message}`);
      }
    }
  }

  // { ok: true } or { ok: false, reason: 'account' | 'ip', retryAfter: ms }. Call before checking a PIN.
  check(account, ip) {
    const t = this.now();
    const ipState = this.state.ips[ip];
    if (ipState && ipState.blockedUntil > t) return { ok: false, reason: 'ip', retryAfter: ipState.blockedUntil - t };
    const acc = this.state.accounts[account];
    if (acc && acc.lockedUntil > t) return { ok: false, reason: 'account', retryAfter: acc.lockedUntil - t };
    return { ok: true };
  }

  // Record a wrong PIN. Returns what check() would now say, so the caller can tell the user about a new lock.
  fail(account, ip) {
    const t = this.now();
    const L = this.limits;

    const acc = this.state.accounts[account] || (this.state.accounts[account] = { fails: 0, level: -1, lockedUntil: 0, lastLock: 0 });
    acc.fails += 1;
    if (acc.fails >= L.accountTries) {
      // lastLock is when the previous lockout ended
      acc.level = acc.lastLock && t - acc.lastLock < L.forgetAfter ? acc.level + 1 : 0;
      acc.lockedUntil = t + this.lockLength(acc.level);
      acc.lastLock = acc.lockedUntil;
      acc.fails = 0;
      console.log(`lockout: account "${account}" locked for ${Math.round(this.lockLength(acc.level) / MINUTE)} min (last try from ${ip})`);
    }

    const ipState = this.state.ips[ip] || (this.state.ips[ip] = { fails: [], blockedUntil: 0 });
    ipState.fails = ipState.fails.filter(f => t - f < L.ipWindow);
    ipState.fails.push(t);
    if (ipState.fails.length >= L.ipTries) {
      ipState.blockedUntil = t + L.ipLock;
      ipState.fails = [];
      console.log(`lockout: IP ${ip} blocked for ${Math.round(L.ipLock / MINUTE)} min`);
    }

    this.prune(t);
    this.save();
    return this.check(account, ip);
  }

  // Record a correct PIN: the account's wrong-PIN count starts over. The IP's count doesn't,
  // so knowing one PIN can't be used to keep guessing others.
  succeed(account) {
    const acc = this.state.accounts[account];
    if (acc && acc.fails) {
      acc.fails = 0;
      this.save();
    }
  }

  // Wrong PINs left before this account locks.
  triesLeft(account) {
    const acc = this.state.accounts[account];
    return this.limits.accountTries - (acc ? acc.fails : 0);
  }

  // Admin: lift an account's lockout and forget its history.
  unlock(account) {
    delete this.state.accounts[account];
    this.save();
  }

  lockLength(level) {
    return Math.min(this.limits.firstLock * 2 ** Math.max(level, 0), this.limits.maxLock);
  }

  prune(t) {
    for (const [ip, s] of Object.entries(this.state.ips)) {
      if (s.blockedUntil <= t && !s.fails.some(f => t - f < this.limits.ipWindow)) delete this.state.ips[ip];
    }
    for (const [name, a] of Object.entries(this.state.accounts)) {
      if (!a.fails && a.lockedUntil <= t && t - a.lastLock > this.limits.forgetAfter) delete this.state.accounts[name];
    }
  }

  save() {
    if (this.file) writeJSON(this.file, this.state);
  }
}

module.exports = { Lockout, DEFAULTS };
