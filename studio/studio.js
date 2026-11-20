// Artist portal page: log in with a PIN (artists) or password (admin), and the admin's
// artist management. Talks to the portal service at /studio/api/.
(function () {
  const view = document.getElementById('view');
  const loading = document.getElementById('loading');

  // h('p', { class: 'x' }, 'text', child, ...) builds an element; text is never parsed as HTML.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  async function api(method, path, body) {
    let r;
    try {
      r = await fetch(`/studio/api/${path}`, {
        method,
        credentials: 'same-origin',
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
        body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
      });
    } catch {
      throw Object.assign(new Error("Couldn't reach the portal. Check your connection and try again."), { status: 0 });
    }
    let data = {};
    try { data = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: r.status, data });
    return data;
  }

  function show(...nodes) {
    loading.hidden = true;
    view.hidden = false;
    view.replaceChildren(...nodes.flat().filter(n => n != null && n !== false));
    const focus = view.querySelector('[autofocus]');
    if (focus) focus.focus();
    window.scrollTo(0, 0);
  }

  function message() {
    const el = h('p', { class: 'message', role: 'status', 'aria-live': 'polite' });
    el.set = (text, kind = 'error') => { el.textContent = text || ''; el.className = `message ${kind}`; };
    return el;
  }

  // Disable a form's buttons while a request runs, and show its error if it fails.
  function submitting(form, msg, work) {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const buttons = form.querySelectorAll('button');
      buttons.forEach(b => { b.disabled = true; });
      msg.set('');
      try {
        await work();
      } catch (err) {
        msg.set(err.message);
      } finally {
        buttons.forEach(b => { b.disabled = false; });
      }
    });
  }

  async function start() {
    try {
      route(await api('GET', 'status'));
    } catch (err) {
      show(h('h1', null, 'Artist Portal'), h('p', { class: 'message error' }, err.message),
        h('button', { class: 'btn secondary', onclick: start }, 'Try again'));
    }
  }

  function route(status) {
    if (status.setupNeeded) return setupView();
    if (status.me && status.me.role === 'admin') return adminView();
    if (status.me) return artistView(status.me);
    return pickArtistView(status.artists);
  }

  // ----- Logging in -----

  function pickArtistView(artists) {
    const canAny = artists.some(a => a.canLogin);
    show(
      h('h1', null, 'Log in'),
      h('p', { class: 'muted' }, canAny ? 'Tap your name.' : 'No artist logins are set up yet. Ask the shop for your PIN.'),
      h('div', { class: 'stack' }, artists.map(a => h('button', {
        class: 'btn secondary artist-btn',
        disabled: !a.canLogin,
        onclick: () => pinView(a, artists),
      }, a.name, a.canLogin ? null : h('small', null, 'No PIN yet')))),
      h('p', { style: 'margin-top: 32px; text-align: center' },
        h('button', { class: 'link', onclick: () => adminLoginView(artists) }, 'Admin login')),
    );
  }

  function pinView(artist, artists) {
    const msg = message();
    const pin = h('input', {
      class: 'pin', id: 'pin', name: 'pin', type: 'password', inputmode: 'numeric', pattern: '[0-9]{6}',
      maxlength: '6', autocomplete: 'current-password', required: true, autofocus: true, 'aria-label': '6-digit PIN',
    });
    const form = h('form', { class: 'stack' },
      // Lets the phone's password manager remember the PIN for this artist.
      h('input', { type: 'text', name: 'username', autocomplete: 'username', value: artist.id, hidden: true, readonly: true }),
      h('label', { for: 'pin' }, 'Your 6-digit PIN'),
      pin,
      h('button', { class: 'btn', type: 'submit' }, 'Log in'),
      msg,
    );
    submitting(form, msg, async () => {
      try {
        const r = await api('POST', 'login', { artist: artist.id, pin: pin.value });
        artistView(r.me);
      } catch (err) {
        pin.value = '';
        pin.focus();
        throw err;
      }
    });
    pin.addEventListener('input', () => {
      pin.value = pin.value.replace(/\D/g, '').slice(0, 6);
      if (pin.value.length === 6) form.requestSubmit();
    });
    show(
      h('h1', null, artist.name),
      form,
      h('p', { style: 'margin-top: 24px' }, h('button', { class: 'link', onclick: () => pickArtistView(artists) }, '← Not you? Pick a different name')),
    );
  }

  function adminLoginView(artists) {
    const msg = message();
    const pw = h('input', { id: 'pw', type: 'password', autocomplete: 'current-password', required: true, autofocus: true });
    const form = h('form', { class: 'stack' },
      h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'admin', hidden: true, readonly: true }),
      h('label', { for: 'pw' }, 'Admin password'), pw,
      h('button', { class: 'btn', type: 'submit' }, 'Log in'), msg);
    submitting(form, msg, async () => {
      try {
        await api('POST', 'admin/login', { password: pw.value });
        adminView();
      } catch (err) {
        pw.value = '';
        throw err;
      }
    });
    show(h('h1', null, 'Admin'), form,
      h('p', { style: 'margin-top: 24px' }, h('button', { class: 'link', onclick: () => pickArtistView(artists) }, '← Back')));
  }

  function setupView() {
    const msg = message();
    const code = h('input', { id: 'code', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', required: true, autofocus: true });
    const pw = h('input', { id: 'pw', type: 'password', autocomplete: 'new-password', minlength: '12', required: true });
    const pw2 = h('input', { id: 'pw2', type: 'password', autocomplete: 'new-password', required: true });
    const form = h('form', { class: 'stack' },
      h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'admin', hidden: true, readonly: true }),
      h('label', { for: 'code' }, 'Setup code (from the server)'), code,
      h('label', { for: 'pw' }, 'Choose the admin password (12+ characters)'), pw,
      h('label', { for: 'pw2' }, 'Type it again'), pw2,
      h('button', { class: 'btn', type: 'submit' }, 'Set admin password'), msg);
    submitting(form, msg, async () => {
      if (pw.value !== pw2.value) throw new Error("The two passwords don't match.");
      await api('POST', 'setup', { code: code.value, password: pw.value });
      adminView();
    });
    show(h('h1', null, 'First-time setup'),
      h('p', { class: 'muted' }, 'Set the admin password. You\'ll use it to give each artist their PIN.'), form);
  }

  function signOutButtons() {
    return h('div', { class: 'stack', style: 'margin-top: 40px' },
      h('button', { class: 'btn secondary', onclick: async () => { await api('POST', 'logout').catch(() => {}); start(); } }, 'Log out'),
      h('button', {
        class: 'link',
        onclick: async () => {
          if (!confirm('Sign out on every phone and computer?')) return;
          await api('POST', 'logout-everywhere').catch(() => {});
          start();
        },
      }, 'Sign out on all devices'));
  }

  // ----- Artist -----

  function artistView(me) {
    show(
      h('h1', null, `Hi, ${me.name}`),
      h('p', { class: 'muted' }, 'You\'re logged in. Uploading and managing your photos is coming here next.'),
      h('div', { class: 'stack' }, h('a', { class: 'btn secondary', href: '/' }, 'View the website')),
      signOutButtons(),
    );
  }

  // ----- Admin -----

  async function adminView() {
    let artists;
    try {
      artists = await api('GET', 'admin/artists');
    } catch (err) {
      if (err.status === 401) return start();
      return show(h('h1', null, 'Admin'), h('p', { class: 'message error' }, err.message),
        h('button', { class: 'btn secondary', onclick: adminView }, 'Try again'));
    }
    show(
      h('h1', null, 'Admin'),
      h('p', { class: 'muted' }, 'Give each artist a PIN so they can log in and manage their photos.'),
      h('h2', null, 'Artists'),
      artists.map(artistCard),
      h('h2', null, 'Admin password'),
      passwordForm(),
      signOutButtons(),
    );
  }

  function artistCard(a) {
    const msg = message();
    const panel = h('div');
    const act = (label, path, opts = {}) => h('button', {
      class: `btn small ${opts.danger ? 'danger' : 'secondary'}`,
      onclick: async () => {
        if (opts.confirm && !confirm(opts.confirm)) return;
        try {
          await api('POST', `admin/artists/${a.id}/${path}`);
          adminView();
        } catch (err) {
          msg.set(err.message);
        }
      },
    }, label);

    const facts = [
      a.hasPin ? 'Has a PIN' : h('span', { class: 'warn' }, 'No PIN yet (can\'t log in)'),
      a.lockedFor ? h('span', { class: 'warn' }, `Locked out for ${a.lockedFor}`) : null,
      a.signedIn ? `Signed in on ${a.signedIn} device${a.signedIn === 1 ? '' : 's'}` : null,
    ].filter(Boolean);

    return h('div', { class: 'card' },
      h('div', { class: 'card-title' }, a.name, h('span', { class: 'muted', style: 'font-size: 0.9rem; font-weight: 400' }, `${a.photos} photos`)),
      h('p', { class: 'facts' }, facts.flatMap((f, i) => (i ? [' · ', f] : [f]))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn small', onclick: () => panel.replaceChildren(pinPanel(a, panel)) }, a.hasPin ? 'New PIN' : 'Set PIN'),
        a.lockedFor ? act('Unlock', 'unlock') : null,
        a.signedIn ? act('Sign out', 'sign-out', { confirm: `Sign ${a.name} out on every device?` }) : null,
        a.hasPin ? act('Remove login', 'remove-pin', { danger: true, confirm: `Remove ${a.name}'s PIN? They won't be able to log in until you set a new one.` }) : null,
      ),
      panel,
      msg,
    );
  }

  function pinPanel(a, panel) {
    const msg = message();
    const own = h('input', { id: `own-${a.id}`, class: 'pin', type: 'text', inputmode: 'numeric', maxlength: '6', autocomplete: 'off', hidden: true, 'aria-label': 'PIN to set' });
    const choose = h('input', { type: 'radio', name: `how-${a.id}`, onchange: () => { own.hidden = false; own.focus(); } });
    const random = h('input', { type: 'radio', name: `how-${a.id}`, checked: true, onchange: () => { own.hidden = true; } });
    own.addEventListener('input', () => { own.value = own.value.replace(/\D/g, '').slice(0, 6); });
    const form = h('form', { class: 'stack' },
      h('div', { class: 'choice' }, h('label', null, random, 'Random PIN'), h('label', null, choose, 'I\'ll choose')),
      own,
      h('div', { class: 'actions' },
        h('button', { class: 'btn small', type: 'submit' }, 'Save PIN'),
        h('button', { class: 'btn small secondary', type: 'button', onclick: () => panel.replaceChildren() }, 'Cancel')),
      msg);
    submitting(form, msg, async () => {
      const r = await api('POST', `admin/artists/${a.id}/pin`, choose.checked ? { pin: own.value } : {});
      const spaced = `${r.pin.slice(0, 3)} ${r.pin.slice(3)}`;
      panel.replaceChildren(h('div', { class: 'pin-reveal' },
        `Give this PIN to ${a.name}:`, h('strong', null, spaced),
        h('span', { class: 'muted' }, 'It won\'t be shown again. Any devices they were signed in on are signed out.'),
        h('div', { style: 'margin-top: 12px' }, h('button', { class: 'btn small secondary', onclick: adminView }, 'Done'))));
    });
    return form;
  }

  function passwordForm() {
    const msg = message();
    const cur = h('input', { id: 'cur', type: 'password', autocomplete: 'current-password', required: true });
    const pw = h('input', { id: 'npw', type: 'password', autocomplete: 'new-password', minlength: '12', required: true });
    const pw2 = h('input', { id: 'npw2', type: 'password', autocomplete: 'new-password', required: true });
    const form = h('form', { class: 'card stack', style: 'margin-top: 0' },
      h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'admin', hidden: true, readonly: true }),
      h('label', { for: 'cur' }, 'Current password'), cur,
      h('label', { for: 'npw' }, 'New password (12+ characters)'), pw,
      h('label', { for: 'npw2' }, 'Type it again'), pw2,
      h('button', { class: 'btn small', type: 'submit' }, 'Change password'), msg);
    submitting(form, msg, async () => {
      if (pw.value !== pw2.value) throw new Error("The two passwords don't match.");
      await api('POST', 'admin/password', { current: cur.value, password: pw.value });
      form.reset();
      msg.set('Password changed. Other admin logins were signed out.', 'ok');
    });
    return form;
  }

  start();
})();
