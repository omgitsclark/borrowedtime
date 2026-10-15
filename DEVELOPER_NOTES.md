# Developer Notes - Borrowed Time Website

## Important Commands & Workflows

### Local Development Server
Start local preview server (runs on http://localhost:8000):
```bash
cd "c:\Users\CloudHopR\Documents\Projects\borrowedtime\borrowedtime" && python -m http.server 8000
```

### File Synchronization
After editing any `.html` files, run this command to sync with extensionless versions:
```bash
cp chris.html chris && cp dexter.html dexter && cp tombraider.html tombraider && cp caseyleal.html caseyleal && cp hectorortega.html hectorortega && cp masondorow.html masondorow && cp gallery_animals.html gallery_animals && cp gallery_characters.html gallery_characters && cp gallery_color.html gallery_color && cp gallery_floral.html gallery_floral && cp gallery_japanese.html gallery_japanese && cp gallery_memorial.html gallery_memorial && cp gallery_realism.html gallery_realism && cp gallery_religious.html gallery_religious
```

**Why:** The live site serves both `/chris` and `/chris.html` URLs. The extensionless files need to stay in sync with the `.html` files.

**Note:** `index.html` has no extensionless twin — don't create one; the server serves `index.html` directly as the directory index.

### Gallery Thumbnails
Gallery grids and homepage artist cards load small square thumbnails from `images/thumbs/` (mirrors `images/<artist>/`); the lightbox still opens the full-size photo. After adding or changing any artist photos, run from the repo root:
```bash
python tools/make_thumbnails.py
```
It only processes new/changed photos (needs Pillow). If a thumbnail is ever missing, the page falls back to the full-size image automatically, so nothing breaks; it's just heavier until the script is run.

### Web-Sized Copies of Big Photos
Large photos shown outside the galleries (the homepage lobby banner, Dexter's bio portrait) are served from `images/web/`: resized copies (2000px banner, 1200px portrait, ~200–400 KB) of the camera originals, which stay where they are (`images/store/`, `images/dexter/`). The thumbnail script skips `web/` and `store/`. When adding or replacing a big non-gallery photo, save a resized copy into `images/web/` and link that, never the multi-MB original.

### Deploying
The Lightsail server (Amazon Linux 2023, Apache) serves the git checkout at `/var/www/html/borrowedtime` directly and pulls it on its own: `/etc/cron.d/borrowedtime-pull` is one line,
```
*/2 * * * * ec2-user /usr/bin/flock -n /tmp/borrowedtime-pull.lock /usr/bin/git -C /var/www/html/borrowedtime pull -q >> /home/ec2-user/borrowedtime-pull.log 2>&1
```
So pushing to `main` is the whole deploy; it's live within ~2 minutes (no restart, static files only). Pull errors land in `/home/ec2-user/borrowedtime-pull.log`. To deploy by hand anyway: `git -C /var/www/html/borrowedtime pull`.

Apache config: the site's vhosts are in `/etc/httpd/conf/httpd.conf` (port 80, redirects to https) and `/etc/httpd/conf/httpd-le-ssl.conf` (443). Folder listings are off for every site via `/etc/httpd/conf.d/zz-no-indexes.conf` (`Options -Indexes` on `/var/www/html`, added 2026-10-15), so a folder URL like `/images/dexter/` returns 403; `.git/` and other dot-folders are blocked by `conf.d/deny-hidden.conf`.

### Traffic Guard (bandwidth cap)
`/etc/cron.d/traffic-guard` runs `/usr/local/bin/traffic-guard.sh` as root every 5 minutes. It adds up the server's network traffic (in + out) for the month in `/var/lib/traffic-guard/YYYY-MM` (bytes) and **stops Apache once the month passes 800 GB**, to stay under the Lightsail transfer allowance. Stopping Apache takes down every site on the box (borrowedtime, clarknavidad, ...), and nothing starts it again on its own, not even when the new month begins.
- Usage so far this month: `sudo awk '{printf "%.1f GB\n", $1/1024^3}' /var/lib/traffic-guard/$(date +%Y-%m)`
- Did it fire? `sudo journalctl -t traffic-guard` (it logs "stopped httpd")
- Bring the sites back: `sudo systemctl start httpd` (if it's still the same month, it'll stop again within 5 minutes unless `LIMIT_GB` in the script is raised)

This is why big images matter: serve thumbnails and `images/web/` copies, never multi-MB originals on page load.

### CSS Cache Busting
The stylesheet is linked as `css/singlePageTemplate.css?v=N` (check any page for the current N). Whenever `singlePageTemplate.css` changes, bump the `?v=` number in every HTML file's `<link>` tag (all files listed above, plus `index.html`). Without this, returning visitors' browsers can keep serving a stale cached copy of the CSS after a deploy, since the file has no other cache-busting mechanism.

## Website Structure

### Artist Pages
- **Dexter** - Award-winning artist
- **Tomb Raider** - Floral specialist
- **Chris** - Detail perfectionist
- **Casey Leal** - Bold traditional & color specialist
- **Hector Ortega** - Black & grey realism specialist
- **Mason Dorow** - Black & gray, custom script & cover-ups specialist

### Studio Portfolio Galleries
All galleries include work from all artists with reference codes:
- `gallery_animals.html` - Animal designs
- `gallery_characters.html` - Character designs
- `gallery_color.html` - Color work
- `gallery_floral.html` - Floral designs
- `gallery_japanese.html` - Japanese style
- `gallery_memorial.html` - Memorial pieces
- `gallery_realism.html` - Realism work
- `gallery_religious.html` - Religious themes

### Key Features
- Lightbox image viewer with keyboard navigation (← → Esc)
- Scroll-to-top button (appears after 300px scroll)
- Mobile-responsive design
- Category filtering on artist pages
- Artist attribution in studio gallery lightboxes

## Design Decisions

### Button Centering (Lightbox & Scroll-to-Top)
- Used CSS `::before` pseudo-elements with `margin-top: -3px` for arrow positioning
- Flexbox centering with `display: flex`, `align-items: center`, `justify-content: center`
- Consistent `font-family: Arial, sans-serif` for cross-browser symbol rendering

### URL Structure
- Maintaining both `.html` and extensionless URLs for compatibility
- Not using `.htaccess` rewriting (yet) - using file duplication instead
- Future: Consider implementing Apache URL rewriting

## Notes
- Always test changes locally before deploying
- Remember to sync extensionless files after updates
- Profile images should be named `[artist]_profile.png` or `.jpg`
- Reference codes follow pattern: `[CATEGORY]-[ARTIST]-[NUMBER]` (e.g., `AN-C01` = Animals-Chris-01)
