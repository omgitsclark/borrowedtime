// Artist portal page: log in with a PIN (artists) or password (admin), artists' photo
// management, and the admin's artist management. Talks to the portal service at /studio/api/.
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

  // ----- Photos (an artist's own, or any artist's for the admin) -----

  const MAX_SIDE = 2400; // photos are shrunk on the phone first: faster uploads on cell data

  function thumbUrl(file) { return `/images/thumbs/${file}`; }
  function photoUrl(file) { return `/images/${file}`; }

  function thumbImg(file, alt) {
    const img = h('img', { src: thumbUrl(file), alt, loading: 'lazy' });
    img.onerror = () => { img.onerror = null; img.src = photoUrl(file); };
    return img;
  }

  // Shrinks a photo and turns it into a JPEG (this also converts iPhone HEIC photos, which the
  // server can't read). If the browser can't read it either, the original is sent as is.
  async function prepare(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
      return blob || file;
    } catch {
      return file;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function sendPhoto(path, blob) {
    let r;
    try {
      r = await fetch(`/studio/api/${path}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        body: blob,
      });
    } catch {
      throw Object.assign(new Error("Couldn't reach the portal. Check your connection and try again."), { status: 0 });
    }
    let data = {};
    try { data = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Please try again.'), { status: r.status, data });
    return data;
  }

  // Style buttons that toggle on and off. onchange gets the list of chosen style ids.
  function styleChips(tags, chosen, onchange) {
    const picked = new Set(chosen);
    return h('div', { class: 'chips' }, tags.map(t => h('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(picked.has(t.id)),
      onclick: e => {
        const on = !picked.has(t.id);
        if (on) picked.add(t.id); else picked.delete(t.id);
        e.currentTarget.setAttribute('aria-pressed', String(on));
        onchange(tags.map(x => x.id).filter(id => picked.has(id)));
      },
    }, t.label)));
  }

  function studioNote(tags) {
    const names = tags.filter(t => t.studio).map(t => t.label);
    return h('p', { class: 'muted small' },
      `${names.join(', ')} also put the photo in the shop's gallery for that style.`);
  }

  // asAdmin: the admin is managing this artist's photos, so links go back to the admin page.
  async function photosView(artistId, asAdmin) {
    const query = asAdmin ? `?artist=${encodeURIComponent(artistId)}` : '';
    let data;
    try {
      data = await api('GET', `photos${query}`);
    } catch (err) {
      if (err.status === 401) return start();
      return show(h('h1', null, 'Photos'), h('p', { class: 'message error' }, err.message),
        h('button', { class: 'btn secondary', onclick: () => photosView(artistId, asAdmin) }, 'Try again'));
    }
    const ctx = {
      asAdmin,
      artistId,
      data,
      // Runs a change; the server answers with the artist's updated photo list.
      async change(work) {
        try {
          ctx.data = await work();
        } catch (err) {
          if (err.status === 401) { start(); throw new Error('Please log in again.'); }
          throw err;
        }
      },
    };
    gridView(ctx);
  }

  function gridView(ctx, notice) {
    const { data } = ctx;
    const msg = message();
    if (notice) msg.set(notice, 'ok');
    const n = data.photos.length;
    const input = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'visually-hidden', id: 'add-photos' });
    input.addEventListener('change', () => {
      if (input.files.length) uploadView(ctx, [...input.files]);
    });
    show(
      ctx.asAdmin
        ? h('p', null, h('button', { class: 'link', onclick: adminView }, '← Admin'))
        : null,
      h('h1', null, ctx.asAdmin ? `${data.artist.name}'s photos` : `Hi, ${data.artist.name}`),
      h('p', { class: 'muted' }, `${n} photo${n === 1 ? '' : 's'} on ${ctx.asAdmin ? 'their' : 'your'} page. `,
        h('a', { href: `/${data.artist.page}`, target: '_blank', rel: 'noopener' }, 'See the page')),
      h('div', { class: 'stack' },
        h('label', { class: 'btn', for: 'add-photos', role: 'button', tabindex: '0',
          onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
        'Add photos'), input),
      msg,
      n ? h('p', { class: 'muted small', style: 'margin-top: 20px' }, 'Tap a photo to change its styles, move it or delete it. The first photos show first on the page.') : null,
      h('div', { class: 'photo-grid' }, data.photos.map((p, i) => h('button', {
        class: 'photo-tile',
        type: 'button',
        'aria-label': `Photo ${i + 1}${p.tags.length ? `: ${p.tags.join(', ')}` : ''}`,
        onclick: () => photoView(ctx, p.id),
      }, thumbImg(p.file, ''), p.before ? h('span', { class: 'badge' }, 'Before/after') : null,
      p.tags.length ? null : h('span', { class: 'badge warn' }, 'No styles')))),
      ctx.asAdmin ? null : signOutButtons(),
    );
  }

  function uploadView(ctx, files) {
    const { data } = ctx;
    let tags = [];
    const msg = message();
    const status = h('p', { class: 'upload-status', role: 'status', 'aria-live': 'polite' });
    const previews = files.map(f => {
      const url = URL.createObjectURL(f);
      const img = h('img', { src: url, alt: '' });
      img.onload = () => URL.revokeObjectURL(url);
      img.onerror = () => { URL.revokeObjectURL(url); img.hidden = true; };
      return h('div', { class: 'preview' }, img);
    });
    const go = h('button', { class: 'btn', type: 'button' }, `Upload ${files.length} photo${files.length === 1 ? '' : 's'}`);
    const cancel = h('button', { class: 'btn secondary', type: 'button', onclick: () => gridView(ctx) }, 'Cancel');
    go.addEventListener('click', async () => {
      go.disabled = cancel.disabled = true;
      const failed = [];
      let done = 0;
      // Each new photo goes first on the page, so sending the last one first keeps the picked order.
      for (let i = files.length - 1; i >= 0; i--) {
        const file = files[i];
        status.textContent = `Uploading ${files.length - i} of ${files.length}…`;
        previews[i].classList.add('busy');
        try {
          const blob = await prepare(file);
          const query = new URLSearchParams({ tags: tags.join(',') });
          if (ctx.asAdmin) query.set('artist', ctx.artistId);
          await ctx.change(() => sendPhoto(`photos/upload?${query}`, blob));
          done++;
          previews[i].classList.replace('busy', 'done');
        } catch (err) {
          previews[i].classList.replace('busy', 'failed');
          failed.push(`Photo ${i + 1}: ${err.message}`);
          if (err.status === 401) return;
        }
      }
      status.textContent = '';
      if (!failed.length) return gridView(ctx, `${done} photo${done === 1 ? '' : 's'} added. ${done === 1 ? 'It\'s' : 'They\'re'} on the website now.`);
      msg.set(`${done} of ${files.length} uploaded. ${failed.reverse().join(' ')}`);
      cancel.disabled = false;
      cancel.textContent = 'Back to photos';
    });
    show(
      h('h1', null, `Add ${files.length} photo${files.length === 1 ? '' : 's'}`),
      h('div', { class: 'preview-row' }, previews),
      h('h2', null, 'Styles'),
      h('p', { class: 'muted small' }, 'Pick the styles that fit. You can change them for each photo later.'),
      styleChips(data.tags, tags, t => { tags = t; }),
      studioNote(data.tags),
      h('div', { class: 'stack' }, go, status, cancel),
      msg,
    );
  }

  function photoView(ctx, id) {
    const photos = ctx.data.photos;
    const index = photos.findIndex(p => p.id === id);
    if (index < 0) return gridView(ctx);
    const photo = photos[index];
    const msg = message();
    const back = () => gridView(ctx);

    // Runs a change, then redraws this photo (or the grid if it's gone).
    const act = async (work, after = () => photoView(ctx, id)) => {
      msg.set('');
      view.querySelectorAll('button').forEach(b => { b.disabled = true; });
      try {
        await ctx.change(work);
        after();
      } catch (err) {
        view.querySelectorAll('button').forEach(b => { b.disabled = false; });
        msg.set(err.message);
      }
    };

    const move = to => {
      const ids = photos.map(p => p.id).filter(x => x !== id);
      ids.splice(Math.max(0, Math.min(to, ids.length)), 0, id);
      act(() => api('POST', 'photos/order', { artist: ctx.artistId, ids }));
    };

    const saved = message();
    let saving = Promise.resolve();
    const chips = styleChips(ctx.data.tags, photo.tags, tags => {
      // Saved as soon as a style is tapped, one change at a time.
      saving = saving.then(async () => {
        saved.set('Saving…', 'muted');
        try {
          await ctx.change(() => api('POST', 'photos/tags', { id, tags }));
          saved.set('Saved', 'ok');
          refs.replaceChildren(...refText());
        } catch (err) {
          saved.set(err.message);
        }
      });
    });
    const refText = () => {
      const p = ctx.data.photos.find(x => x.id === id);
      const entries = p ? Object.entries(p.refs) : [];
      if (!entries.length) return ['Not in any of the shop\'s style galleries.'];
      const label = t => (ctx.data.tags.find(x => x.id === t) || { label: t }).label;
      return [`In the shop's galleries as ${entries.map(([t, ref]) => `${ref} (${label(t)})`).join(', ')}.`];
    };
    const refs = h('p', { class: 'muted small' }, ...refText());

    const beforeInput = h('input', { type: 'file', accept: 'image/*', class: 'visually-hidden', id: 'before-photo' });
    beforeInput.addEventListener('change', () => {
      const file = beforeInput.files[0];
      if (!file) return;
      msg.set('Uploading the before photo…', 'muted');
      act(async () => sendPhoto(`photos/before?id=${encodeURIComponent(id)}`, await prepare(file)));
    });

    const last = photos.length - 1;
    show(
      h('p', null, h('button', { class: 'link', onclick: back }, '← All photos')),
      h('div', { class: 'photo-large' }, h('img', { src: photoUrl(photo.file), alt: `Photo ${index + 1}` })),
      h('p', { class: 'muted small', style: 'text-align: center' }, `Photo ${index + 1} of ${photos.length} on the page`),

      h('h2', null, 'Styles'),
      chips, saved, refs,

      h('h2', null, 'Place on the page'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn small secondary', disabled: index === 0, onclick: () => move(0) }, 'Move to first'),
        h('button', { class: 'btn small secondary', disabled: index === 0, onclick: () => move(index - 1) }, '↑ Earlier'),
        h('button', { class: 'btn small secondary', disabled: index === last, onclick: () => move(index + 1) }, '↓ Later'),
        h('button', { class: 'btn small secondary', disabled: index === last, onclick: () => move(last) }, 'Move to last')),

      h('h2', null, 'Before photo'),
      photo.before
        ? h('div', { class: 'before-row' },
          h('img', { src: photoUrl(photo.before), alt: 'Before' }),
          h('div', { class: 'actions' },
            h('label', { class: 'btn small secondary', for: 'before-photo', role: 'button', tabindex: '0' }, 'Replace'),
            h('button', {
              class: 'btn small danger',
              onclick: () => { if (confirm('Remove the before photo?')) act(() => api('POST', 'photos/remove-before', { id })); },
            }, 'Remove')))
        : h('div', null,
          h('p', { class: 'muted small' }, 'For cover-ups and reworks: visitors can switch between before and after.'),
          h('label', { class: 'btn small secondary', for: 'before-photo', role: 'button', tabindex: '0' }, 'Add a before photo')),
      beforeInput,

      msg,
      h('div', { class: 'stack', style: 'margin-top: 40px' },
        h('button', {
          class: 'btn danger',
          onclick: () => {
            if (!confirm('Delete this photo from the website?')) return;
            act(() => api('POST', 'photos/delete', { id }), () => gridView(ctx, 'Photo deleted.'));
          },
        }, 'Delete photo'),
        h('button', { class: 'btn secondary', onclick: back }, 'Back to all photos')),
    );
  }

  function artistView(me) {
    return photosView(me.id, false);
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
        h('button', { class: 'btn small secondary', onclick: () => photosView(a.id, true) }, 'Photos'),
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
      const card = h('div', { class: 'card-share' }, h('p', { class: 'muted small' }, 'Making a login card…'));
      let cardUrl = null;
      panel.replaceChildren(h('div', { class: 'pin-reveal' },
        `Give this PIN to ${a.name}:`, h('strong', null, spaced),
        h('span', { class: 'muted' }, 'It won\'t be shown again. Any devices they were signed in on are signed out.'),
        card,
        h('div', { style: 'margin-top: 12px' }, h('button', {
          class: 'btn small secondary',
          onclick: () => { if (cardUrl) URL.revokeObjectURL(cardUrl); adminView(); },
        }, 'Done'))));
      try {
        const blob = await pinCard(a.name, r.pin);
        const name = `borrowed-time-login-${a.id}.png`;
        const file = new File([blob], name, { type: 'image/png' });
        cardUrl = URL.createObjectURL(blob);
        const canShare = navigator.canShare && navigator.canShare({ files: [file] });
        card.replaceChildren(
          h('img', { src: cardUrl, alt: `Login card for ${a.name} with their PIN and how to log in` }),
          h('div', { class: 'actions', style: 'justify-content: center' },
            canShare ? h('button', {
              class: 'btn small',
              onclick: () => navigator.share({ files: [file], title: 'Borrowed Time artist login' }).catch(() => {}),
            }, 'Share card') : null,
            h('a', { class: `btn small ${canShare ? 'secondary' : ''}`, href: cardUrl, download: name }, 'Save picture')),
          h('p', { class: 'muted small' }, 'The card shows the PIN, so send it only to them.'));
      } catch {
        card.replaceChildren();
      }
    });
    return form;
  }

  // A picture (1080 x 1350 PNG) with the artist's PIN and how to log in, to text to them.
  async function pinCard(name, pin) {
    const fonts = ['600 80px Fraunces', '700 80px Inter', '600 40px Inter', '400 40px Inter'];
    await Promise.race([Promise.all(fonts.map(f => document.fonts.load(f))), new Promise(r => setTimeout(r, 3000))]).catch(() => {});
    const W = 1080, H = 1350, PAD = 120;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const x = canvas.getContext('2d');
    const sans = (weight, size) => `${weight} ${size}px Inter, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    const round = (rx, ry, rw, rh, r) => {
      x.beginPath();
      x.moveTo(rx + r, ry);
      x.arcTo(rx + rw, ry, rx + rw, ry + rh, r);
      x.arcTo(rx + rw, ry + rh, rx, ry + rh, r);
      x.arcTo(rx, ry + rh, rx, ry, r);
      x.arcTo(rx, ry, rx + rw, ry, r);
      x.closePath();
    };
    const wrap = (text, maxWidth) => {
      const lines = [];
      let line = '';
      for (const word of text.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (line && x.measureText(next).width > maxWidth) { lines.push(line); line = word; } else line = next;
      }
      return lines.concat(line);
    };
    // Draws text with extra space between letters (canvas letter-spacing isn't everywhere yet).
    const spaced = (text, cx, y, gap) => {
      const widths = [...text].map(ch => x.measureText(ch).width);
      let left = cx - (widths.reduce((s, w) => s + w, 0) + gap * (text.length - 1)) / 2;
      x.textAlign = 'left';
      [...text].forEach((ch, i) => { x.fillText(ch, left, y); left += widths[i] + gap; });
      x.textAlign = 'center';
    };

    const bg = x.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#0a0a0a');
    bg.addColorStop(0.4, '#1a1a1a');
    bg.addColorStop(0.7, '#1e1e1e');
    bg.addColorStop(1, '#0a0a0a');
    x.fillStyle = bg;
    x.fillRect(0, 0, W, H);
    round(40, 40, W - 80, H - 80, 32);
    x.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    x.lineWidth = 2;
    x.stroke();

    x.textAlign = 'center';
    x.fillStyle = '#ffffff';
    x.font = '600 80px Fraunces, Georgia, serif';
    x.fillText('Borrowed Time', W / 2, 180);
    x.fillStyle = '#b8b8b8';
    x.font = sans(600, 28);
    spaced('ARTIST PORTAL LOGIN', W / 2, 232, 6);
    x.fillStyle = '#2C9AB7';
    x.fillRect(W / 2 - 60, 268, 120, 4);

    x.fillStyle = '#ffffff';
    x.font = sans(600, 56);
    x.fillText(name, W / 2, 370);
    x.fillStyle = '#b8b8b8';
    x.font = sans(400, 34);
    x.fillText('Your PIN', W / 2, 425);

    round(PAD, 460, W - PAD * 2, 200, 28);
    x.fillStyle = 'rgba(44, 154, 183, 0.12)';
    x.fill();
    x.setLineDash([16, 12]);
    x.strokeStyle = '#5CC3DE';
    x.lineWidth = 4;
    x.stroke();
    x.setLineDash([]);
    x.fillStyle = '#ffffff';
    x.font = sans(700, 120);
    spaced(`${pin.slice(0, 3)} ${pin.slice(3)}`, W / 2, 605, 22);

    x.textAlign = 'left';
    x.fillStyle = '#ffffff';
    x.font = sans(600, 40);
    x.fillText('How to log in', PAD, 760);
    const site = `${location.host.replace(/^www\./, '')}/studio`;
    const steps = [
      [['Open this on your phone:', sans(400, 34), '#ffffff'], [site, sans(700, 34), '#5CC3DE']],
      [[`Tap your name: ${name}`, sans(400, 34), '#ffffff']],
      [['Type your PIN. Your phone stays logged in for 30 days.', sans(400, 34), '#ffffff']],
    ];
    let y = 840;
    const textLeft = PAD + 80, textWidth = W - PAD - textLeft;
    steps.forEach((parts, i) => {
      x.beginPath();
      x.arc(PAD + 28, y - 12, 28, 0, Math.PI * 2);
      x.fillStyle = '#2C9AB7';
      x.fill();
      x.fillStyle = '#04181d';
      x.font = sans(700, 30);
      x.textAlign = 'center';
      x.fillText(String(i + 1), PAD + 28, y - 1);
      x.textAlign = 'left';
      for (const [text, font, color] of parts) {
        x.font = font;
        x.fillStyle = color;
        // Shrink a long web address to fit on one line.
        let size = 34;
        while (text === site && x.measureText(text).width > textWidth && size > 22) x.font = font.replace(/\d+px/, `${--size}px`);
        for (const line of wrap(text, textWidth)) { x.fillText(line, textLeft, y); y += 48; }
      }
      y += 36;
    });

    x.textAlign = 'center';
    x.fillStyle = '#b8b8b8';
    x.font = sans(400, 28);
    y = Math.max(y + 10, H - 150);
    for (const line of wrap('Keep this PIN private. Forgot it? Ask the shop for a new one.', W - PAD * 2)) {
      x.fillText(line, W / 2, y);
      y += 40;
    }

    return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('no image'))), 'image/png'));
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
