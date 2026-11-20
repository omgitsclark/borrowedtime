'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Lockout } = require('../lib/lockout');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function clock() {
  let t = Date.UTC(2026, 10, 20, 12);
  const now = () => t;
  now.advance = ms => { t += ms; };
  return now;
}

test('5 wrong PINs lock the account for 15 minutes', () => {
  const now = clock();
  const lock = new Lockout({ now });
  for (let i = 0; i < 4; i++) assert.deepStrictEqual(lock.fail('chris', '1.1.1.1'), { ok: true });
  const r = lock.fail('chris', '1.1.1.1');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'account');
  assert.strictEqual(r.retryAfter, 15 * MIN);
  assert.strictEqual(lock.check('chris', '2.2.2.2').ok, false, 'locked from every IP');
  assert.strictEqual(lock.check('dexter', '2.2.2.2').ok, true, 'other artists unaffected');
  now.advance(15 * MIN);
  assert.strictEqual(lock.check('chris', '2.2.2.2').ok, true, 'unlocks after 15 minutes');
});

test('each further lockout doubles, up to 24 hours', () => {
  const now = clock();
  const lock = new Lockout({ now, ipTries: Infinity });
  const lengths = [];
  for (let round = 0; round < 9; round++) {
    let r;
    for (let i = 0; i < 5; i++) r = lock.fail('chris', '1.1.1.1');
    lengths.push(r.retryAfter / MIN);
    now.advance(r.retryAfter);
  }
  assert.deepStrictEqual(lengths, [15, 30, 60, 120, 240, 480, 960, 1440, 1440]);
});

test('a day with no lockout starts the doubling over', () => {
  const now = clock();
  const lock = new Lockout({ now, ipTries: Infinity });
  for (let i = 0; i < 5; i++) lock.fail('chris', '1.1.1.1');
  now.advance(15 * MIN);
  for (let i = 0; i < 5; i++) lock.fail('chris', '1.1.1.1');
  now.advance(30 * MIN + 25 * HOUR);
  let r;
  for (let i = 0; i < 5; i++) r = lock.fail('chris', '1.1.1.1');
  assert.strictEqual(r.retryAfter, 15 * MIN);
});

test('a correct PIN resets the wrong-PIN count', () => {
  const lock = new Lockout({ now: clock() });
  for (let i = 0; i < 4; i++) lock.fail('chris', '1.1.1.1');
  lock.succeed('chris');
  for (let i = 0; i < 4; i++) assert.strictEqual(lock.fail('chris', '1.1.1.1').ok, true);
});

test('10 wrong PINs from one IP across artists block that IP for an hour', () => {
  const now = clock();
  const lock = new Lockout({ now });
  const artists = ['chris', 'dexter', 'tombraider', 'hector', 'mason'];
  let r;
  for (let i = 0; i < 10; i++) r = lock.fail(artists[i % 5], '6.6.6.6');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'ip');
  assert.strictEqual(r.retryAfter, HOUR);
  assert.strictEqual(lock.check('chris', '7.7.7.7').ok, true, 'other IPs can still log in');
  now.advance(HOUR);
  assert.strictEqual(lock.check('chris', '6.6.6.6').ok, true);
});

test('slow guessing from one IP does not add up to a block', () => {
  const now = clock();
  const lock = new Lockout({ now, accountTries: Infinity });
  for (let i = 0; i < 30; i++) {
    assert.strictEqual(lock.fail('chris', '1.1.1.1').ok, true);
    now.advance(2 * MIN);
  }
});

test('lockouts survive a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lockout-')), 'state.json');
  const now = clock();
  const first = new Lockout({ file, now });
  for (let i = 0; i < 5; i++) first.fail('chris', '1.1.1.1');
  const second = new Lockout({ file, now });
  assert.strictEqual(second.check('chris', '1.1.1.1').ok, false);
  second.unlock('chris');
  assert.strictEqual(new Lockout({ file, now }).check('chris', '3.3.3.3').ok, true, 'admin unlock sticks');
});

test('a damaged state file starts empty instead of crashing', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lockout-')), 'state.json');
  fs.writeFileSync(file, '{not json');
  const lock = new Lockout({ file, now: clock() });
  assert.strictEqual(lock.check('chris', '1.1.1.1').ok, true);
});
