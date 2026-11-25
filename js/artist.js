// Artist pages: fills in the signature strip, style cards, portfolio wall and lightbox from
// data/gallery.json (the same list the artist portal edits), so a photo an artist uploads,
// deletes or retags shows up here with no page edits. Each page calls:
//   BTArtist({ artist: 'dexter', featured: ['dexter/a.jpg', ...] })
// featured: photos for the "Start with the best" strip, by file. Ones that have since been
// deleted are skipped, and the artist's newest photos fill any gap.
(function () {
  const MEDIA = 'images';
  const PAGE = 12;            // portfolio photos shown per "Show more"
  const SMALL = 16;           // below this many photos, skip the strip and style cards
  const thumbSrc = f => `${MEDIA}/thumbs/${f}`;
  const fullSrc = f => `${MEDIA}/${f}`;
  const $ = id => document.getElementById(id);

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function img(file, alt) {
    const i = new Image();
    i.loading = 'lazy';
    i.decoding = 'async';
    i.alt = alt;
    i.src = thumbSrc(file);
    i.onerror = () => { i.onerror = null; i.src = fullSrc(file); };
    return i;
  }

  // ---- Page chrome: nav shading, phone booking bar, before/after slider, video ----
  const nav = document.querySelector('.nav');
  const bar = document.querySelector('.bar');
  const onScroll = () => {
    nav && nav.classList.toggle('solid', scrollY > 30);
    bar && bar.classList.toggle('show', scrollY > 500);
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Close the Artists menu when tapping elsewhere.
  document.addEventListener('click', e => {
    document.querySelectorAll('details.artists[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; });
  });

  document.querySelectorAll('.ba').forEach(ba => {
    const set = e => {
      const r = ba.getBoundingClientRect();
      ba.style.setProperty('--x', Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100)) + '%');
    };
    ba.addEventListener('pointerdown', e => { set(e); ba.setPointerCapture(e.pointerId); });
    ba.addEventListener('pointermove', e => { if (ba.hasPointerCapture(e.pointerId)) set(e); });
  });

  // Videos only play (and download) while on screen.
  document.querySelectorAll('video[data-autoplay]').forEach(v => {
    if (!('IntersectionObserver' in window)) return;
    new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) v.play().catch(() => {}); else v.pause();
    }, { threshold: 0.4 }).observe(v);
  });

  const strip = $('strip');
  if (strip) {
    const by = d => () => strip.scrollBy({ left: d * Math.min(strip.clientWidth * 0.8, 700), behavior: 'smooth' });
    $('stripPrev') && ($('stripPrev').onclick = by(-1));
    $('stripNext') && ($('stripNext').onclick = by(1));
  }

  // ---- Lightbox ----
  const lb = $('lb'), lbImg = $('lbImg'), lbCap = $('lbCap');
  let lbList = [], lbAt = 0, lbBefore = false, labels = {};

  function caption(p) {
    const parts = [];
    const ref = p.refs && Object.values(p.refs)[0];
    if (ref) parts.push(`<b>${esc(ref)}</b>`);
    if (p.tags.length) parts.push(esc(p.tags.map(t => labels[t] || t).join(' · ')));
    let html = `<span>${parts.join('  ·  ')}</span>`;
    if (p.before) html += `<button type="button" id="lbToggle">${lbBefore ? 'Show after' : 'Show before'}</button>`;
    return html;
  }
  function lbShow() {
    const p = lbList[lbAt];
    lbImg.src = fullSrc(lbBefore && p.before ? p.before : p.file);
    lbImg.alt = lbBefore ? 'Before the tattoo' : 'Tattoo';
    lbCap.innerHTML = caption(p);
    const t = $('lbToggle');
    if (t) t.onclick = () => { lbBefore = !lbBefore; lbShow(); };
  }
  function lbOpen(list, i) {
    lbList = list; lbAt = i; lbBefore = false;
    lbShow();
    lb.classList.add('on');
    document.body.style.overflow = 'hidden';
    $('lbClose').focus();
  }
  function lbClose() { lb.classList.remove('on'); document.body.style.overflow = ''; lbImg.removeAttribute('src'); }
  function lbStep(d) { if (lbList.length > 1) { lbAt = (lbAt + d + lbList.length) % lbList.length; lbBefore = false; lbShow(); } }
  if (lb) {
    $('lbClose').onclick = lbClose;
    $('lbPrev').onclick = () => lbStep(-1);
    $('lbNext').onclick = () => lbStep(1);
    lb.addEventListener('click', e => { if (e.target === lb) lbClose(); });
    addEventListener('keydown', e => {
      if (!lb.classList.contains('on')) return;
      if (e.key === 'Escape') lbClose();
      if (e.key === 'ArrowLeft') lbStep(-1);
      if (e.key === 'ArrowRight') lbStep(1);
    });
    let x0 = null;
    lb.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', e => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 50) lbStep(dx < 0 ? 1 : -1);
      x0 = null;
    });
  }

  // ---- Gallery-driven parts ----
  window.BTArtist = function ({ artist, featured = [] }) {
    const grid = $('grid');
    fetch('data/gallery.json', { cache: 'no-cache' })
      .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(g => build(g, artist, featured))
      .catch(() => {
        if (grid) grid.innerHTML = `<p class="gallery-error">The portfolio couldn't load. Please refresh the page.</p>`;
      });
  };

  function build(g, artistId, featured) {
    g.tags.forEach(t => { labels[t.id] = t.label; });
    const all = g.photos.filter(p => p.artist === artistId);
    const small = all.length < SMALL;
    const counts = {};
    all.forEach(p => p.tags.forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
    const styleLabel = p => p.tags.slice(0, 2).map(t => labels[t]).join(' · ');

    document.querySelectorAll('[data-count]').forEach(n => {
      const what = n.dataset.count;
      n.textContent = what === 'all' ? all.length : (counts[what.replace(/^tag:/, '')] || 0);
    });

    // Signature strip: chosen photos, topped up with the newest ones.
    const section = document.querySelector('.signature');
    if (strip && !small) {
      const byFile = new Map(all.map(p => [p.file, p]));
      const picks = featured.map(f => byFile.get(f)).filter(Boolean);
      for (const p of all) {
        if (picks.length >= 8) break;
        if (!picks.includes(p) && !p.before) picks.push(p);
      }
      const statics = [...strip.children];
      picks.forEach((p, i) => {
        const card = el('button', 'card');
        card.type = 'button';
        card.setAttribute('aria-label', `View ${styleLabel(p) || 'tattoo'} larger`);
        const ph = el('div', 'ph');
        ph.appendChild(img(p.file, `${styleLabel(p)} tattoo`));
        card.appendChild(ph);
        const ref = p.refs && Object.values(p.refs)[0];
        card.appendChild(el('div', 'meta', `<h3>${esc(styleLabel(p) || 'Tattoo')}</h3><small>${esc(ref || '')}</small>`));
        card.onclick = () => lbOpen(picks, i);
        strip.appendChild(card);
      });
      // A static card with data-slot="N" moves to position N, so reviews can sit between photos.
      statics.filter(c => c.dataset.slot).forEach(c => {
        const at = strip.children[Number(c.dataset.slot)];
        if (at && at !== c) strip.insertBefore(c, at);
      });
    } else if (section && small && strip && !strip.children.length) {
      section.hidden = true;
    }

    // Style cards: one per style with enough pieces to be worth browsing.
    const styles = g.tags.filter(t => counts[t.id] >= 4).sort((a, b) => counts[b.id] - counts[a.id]);
    const styleGrid = $('styleGrid');
    if (styleGrid) {
      if (small || styles.length < 3) {
        styleGrid.closest('section').hidden = true;
      } else {
        const used = new Set();
        styles.forEach(t => {
          const cover = all.find(p => p.tags.includes(t.id) && !used.has(p.file) && !p.before) || all.find(p => p.tags.includes(t.id));
          used.add(cover.file);
          const b = el('button', 'style');
          b.type = 'button';
          b.appendChild(img(cover.file, ''));
          b.appendChild(el('span', null, `<b>${esc(t.label)}</b><i>${counts[t.id]} pieces</i>`));
          b.onclick = () => { setFilter(t.id); $('portfolio').scrollIntoView({ behavior: 'smooth' }); };
          styleGrid.appendChild(b);
        });
      }
    }

    // Portfolio wall with style chips and "Show more".
    const chips = $('chips'), more = $('moreBtn'), note = $('moreNote');
    let filter = 'all', limit = PAGE;
    const chipTags = g.tags.filter(t => counts[t.id] >= 2).sort((a, b) => counts[b.id] - counts[a.id]);
    if (all.length <= PAGE || chipTags.length < 2) {
      chips.hidden = true;
    } else {
      [{ id: 'all', label: 'All' }, ...chipTags].forEach(t => {
        const c = el('button', 'chip', `${esc(t.label)}<i>${t.id === 'all' ? all.length : counts[t.id]}</i>`);
        c.type = 'button';
        c.dataset.id = t.id;
        c.onclick = () => setFilter(t.id);
        chips.appendChild(c);
      });
    }

    function setFilter(id) {
      filter = id;
      limit = PAGE;
      chips.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.id === id)));
      render();
    }

    function render() {
      const list = filter === 'all' ? all : all.filter(p => p.tags.includes(filter));
      grid.replaceChildren();
      list.slice(0, limit).forEach((p, i) => {
        const b = el('button', 'tile' + (list.length >= 6 && i % 9 === 0 ? ' big' : ''));
        b.type = 'button';
        b.setAttribute('aria-label', `View ${styleLabel(p) || 'tattoo'} larger`);
        const mat = el('div', 'mat');
        const ph = el('div', 'ph');
        ph.appendChild(img(p.file, `${styleLabel(p)} tattoo`));
        mat.appendChild(ph);
        const ref = p.refs && Object.values(p.refs)[0];
        mat.appendChild(el('div', 'plaque', `<b>${esc(ref || '')}</b><span>${esc(p.tags.length ? labels[p.tags[0]] : '')}</span>`));
        b.appendChild(mat);
        if (p.before) b.appendChild(el('span', 'ba-tag', 'Before / after'));
        b.onclick = () => lbOpen(list, i);
        grid.appendChild(b);
      });
      const left = list.length - limit;
      more.hidden = left <= 0;
      more.textContent = `Show ${Math.min(PAGE, left)} more`;
      note.textContent = left > 0 ? `Showing ${limit} of ${list.length}` : (list.length > PAGE ? `That's all ${list.length}` : '');
    }
    more.onclick = () => { limit += PAGE; render(); };
    setFilter('all');
  }
})();
