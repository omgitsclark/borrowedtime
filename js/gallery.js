// Builds the artist and studio gallery grids, filters and lightbox from data/gallery.json.
// Artist pages call BTGallery.artist('<artist id>'); studio galleries call BTGallery.studio('<style id>').
(function () {
  const MEDIA = 'images';          // photos at MEDIA/<file>, thumbnails at MEDIA/thumbs/<file>
  const DATA = 'data/gallery.json';

  const load = fetch(DATA, { cache: 'no-cache' }).then(r => {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  });

  const container = document.getElementById('gallery-container');
  const lightbox = document.getElementById('lightbox');
  const lightboxImage = document.getElementById('lightbox-image');
  const lightboxCaption = document.getElementById('lightbox-caption');
  let toggle = document.getElementById('beforeAfterToggle');
  if (!toggle) {
    toggle = document.createElement('button');
    toggle.className = 'before-after-toggle';
    toggle.id = 'beforeAfterToggle';
    toggle.style.display = 'none';
    lightboxImage.after(toggle);
  }

  let shown = [], current = 0, showingBefore = false, caption = null, showAll = null;

  function thumb(photo, artistName) {
    const div = document.createElement('div');
    div.className = 'gallery-item';
    const img = document.createElement('img');
    img.src = `${MEDIA}/thumbs/${photo.file}`;
    img.onerror = () => { img.onerror = null; img.src = `${MEDIA}/${photo.file}`; };
    img.alt = `${artistName}'s tattoo work`;
    img.loading = 'lazy';
    img.dataset.index = shown.length;
    div.appendChild(img);
    shown.push(photo);
    return div;
  }

  function render(photos, nameOf) {
    container.replaceChildren();
    shown = [];
    const frag = document.createDocumentFragment();
    photos.forEach(p => frag.appendChild(thumb(p, nameOf(p))));
    container.appendChild(frag);
  }

  function update() {
    const photo = shown[current];
    const before = showingBefore && photo.before;
    lightboxImage.src = `${MEDIA}/${before ? photo.before : photo.file}`;
    toggle.style.display = photo.before ? 'block' : 'none';
    toggle.textContent = before ? 'Show After' : 'Show Before';
    if (caption && lightboxCaption) lightboxCaption.replaceChildren(...caption(photo));
  }

  function open(index, before = false) {
    current = index;
    showingBefore = before;
    update();
    lightbox.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    lightbox.classList.remove('active');
    document.body.style.overflow = '';
    showingBefore = false;
  }

  function step(delta) {
    if (!shown.length) return;
    current = (current + delta + shown.length) % shown.length;
    showingBefore = false;
    update();
  }

  container.addEventListener('click', e => {
    if (e.target.tagName === 'IMG') open(parseInt(e.target.dataset.index, 10));
  });
  toggle.addEventListener('click', () => { showingBefore = !showingBefore; update(); });
  document.getElementById('lightbox-close').addEventListener('click', close);
  document.getElementById('lightbox-prev').addEventListener('click', () => step(-1));
  document.getElementById('lightbox-next').addEventListener('click', () => step(1));
  lightbox.addEventListener('click', e => { if (e.target === lightbox) close(); });
  document.addEventListener('keydown', e => {
    if (!lightbox.classList.contains('active')) return;
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });

  function failed() {
    container.replaceChildren();
    const p = document.createElement('p');
    p.className = 'gallery-error';
    p.textContent = "The gallery couldn't load. Please refresh the page.";
    container.appendChild(p);
  }

  window.BTGallery = {
    // An artist's portfolio, with a filter button for each style they've tagged.
    artist(artistId) {
      return load.then(d => {
        const artist = d.artists.find(a => a.id === artistId);
        const photos = d.photos.filter(p => p.artist === artistId);
        const filter = document.getElementById('category-filter');
        const used = d.tags.filter(t => photos.some(p => p.tags.includes(t.id)));
        const show = tag => render(tag === 'all' ? photos : photos.filter(p => p.tags.includes(tag)), () => artist.name);
        filter.replaceChildren(...[{ id: 'all', label: 'All' }, ...used].map(t => {
          const btn = document.createElement('button');
          btn.className = 'filter-btn' + (t.id === 'all' ? ' active' : '');
          btn.dataset.category = t.id;
          btn.textContent = t.label;
          btn.addEventListener('click', () => {
            filter.querySelectorAll('.filter-btn').forEach(b => b.classList.toggle('active', b === btn));
            show(t.id);
          });
          return btn;
        }));
        showAll = () => filter.querySelector('[data-category="all"]').click();
        show('all');
      }).catch(failed);
    },

    // A studio gallery: every photo tagged with this style, in the gallery's saved order.
    studio(styleId) {
      return load.then(d => {
        const byId = new Map(d.photos.map(p => [p.id, p]));
        const artists = new Map(d.artists.map(a => [a.id, a]));
        const photos = d.studio[styleId].order.map(id => byId.get(id))
          .filter(p => p && p.tags.includes(styleId) && artists.has(p.artist));
        caption = p => {
          const a = artists.get(p.artist);
          const link = document.createElement('a');
          link.href = a.page;
          link.style.cssText = 'color: var(--accent-color); text-decoration: none;';
          link.textContent = a.name;
          return [link, ` | Ref: ${(p.refs && p.refs[styleId]) || ''}`];
        };
        render(photos, p => artists.get(p.artist).name);
      }).catch(failed);
    },

    // Open the lightbox on a photo by its file (e.g. from a "Recent Work" panel), optionally on its before shot.
    open(file, before = false) {
      return load.then(() => {
        let index = shown.findIndex(p => p.file === file);
        if (index < 0 && showAll) {
          showAll();
          index = shown.findIndex(p => p.file === file);
        }
        if (index >= 0) open(index, before);
      });
    },
  };
})();
