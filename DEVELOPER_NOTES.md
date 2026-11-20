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
cp chris.html chris && cp dexter.html dexter && cp tombraider.html tombraider && cp hectorortega.html hectorortega && cp masondorow.html masondorow && cp gallery_animals.html gallery_animals && cp gallery_characters.html gallery_characters && cp gallery_color.html gallery_color && cp gallery_floral.html gallery_floral && cp gallery_japanese.html gallery_japanese && cp gallery_memorial.html gallery_memorial && cp gallery_realism.html gallery_realism && cp gallery_religious.html gallery_religious
```

**Why:** The live site serves both `/chris` and `/chris.html` URLs. The extensionless files need to stay in sync with the `.html` files.

**Note:** `index.html` has no extensionless twin — don't create one; the server serves `index.html` directly as the directory index.

### Gallery Data (`data/gallery.json`)
Every gallery photo is listed once, in `data/gallery.json`; the artist pages and studio galleries no longer hold photo lists. `js/gallery.js` reads it and builds the grids, filter buttons and lightbox (`BTGallery.artist('dexter')` on artist pages, `BTGallery.studio('color')` on studio galleries). The file holds:
- `artists`: id (also the photo folder under `images/`), name, page, and reference-code letter(s) (`D`, `T`, `C`, `H`, `MD`).
- `tags`: the style tags. An artist page shows a filter button for each tag that artist has used.
- `photos`: one entry per photo, in each artist's page order: `file` (path under `images/`), `tags`, optional `before` (a before shot; the lightbox then shows a "Show Before" button), and `refs` (its reference code in each studio gallery it's in).
- `studio`: the 8 studio galleries, each with its saved photo `order`. **Galleries are automatic**: a photo tagged `floral` belongs in the Floral gallery. A newly tagged photo goes at the end of that gallery's `order` and gets the next free reference code for its artist (e.g. `FL-T41`); existing codes never change, since customers may quote them.

Created 2026-11-20 from the hand-written lists (phase 1 of the artist upload portal). That merge added a tag wherever a photo was already in that studio gallery, and added already-tagged photos to galleries they weren't listed in (41 photos), so nothing disappeared from any gallery. The upload portal will edit this file; until then, add photos by editing it by hand.

### Artist Portal
Artists will log in with their name and a 6-digit PIN to upload and manage their own gallery photos. The portal is `server/portal.js`, a small Node service (no dependencies yet) run by systemd as `borrowedtime-portal` on 127.0.0.1:8800, as user `borrowedtime`. (Other sites' Node services on the same box already use 8787, 8788, 8790 and 8791: eat-live, photos, cnavidad-live; check `sudo ss -ltnp | grep node` before picking a port.) Apache passes `/studio/api/` to it (`server/apache-portal.conf`, included from the borrowedtime `<VirtualHost *:443>` in `/etc/httpd/conf/httpd-le-ssl.conf`).

**Its data lives outside the git checkout**, in `/var/lib/borrowedtime/`, so `git pull` never touches it:
- `gallery.json`: **the live gallery list**, served as `/data/gallery.json`. The service copied it from the repo's `data/gallery.json` on its first start; from then on the repo copy is only that starting point, and editing it changes nothing on the site.
- `uploads/<artist>/` and `thumbs/<artist>/`: uploaded photos, served as `/images/uploads/...` and `/images/thumbs/uploads/...` (so a photo's `file` is `uploads/<artist>/<name>.jpg`). Photos already in the repo stay in `images/`.
- `private/` (PIN hashes, lockouts) and `backups/`: never served.

Check it: `systemctl status borrowedtime-portal`, `journalctl -u borrowedtime-portal -n 50`, `curl -s https://borrowedtimetattoomckinney.com/studio/api/health`.

**Logging in** (`/studio/`, built by `studio/studio.js`): artists tap their name and type their 6-digit PIN; the admin (Clark) uses "Admin login" and a password of 12+ characters. The admin page sets or replaces each artist's PIN (random, or chosen; easy ones like 123456 or 121212 are refused), unlocks a locked-out artist, signs them out, or removes their login. A new PIN is shown once, and signs that artist out everywhere. Logins last 30 days on an artist's device and 12 hours for the admin; "Sign out on all devices" ends every login for that account.
- **First-time setup / forgotten admin password:** until an admin password exists, the portal writes a one-time code to `/var/lib/borrowedtime/private/setup-code`; read it with `sudo cat` and enter it on `/studio/` with the new password. To reset a forgotten admin password: `sudo systemctl stop borrowedtime-portal`, remove the `"admin"` entry from `/var/lib/borrowedtime/private/accounts.json` (set it to `null`), `sudo systemctl start borrowedtime-portal`, then use the new setup code.
- `private/accounts.json` holds only scrypt hashes of PINs and the admin password; `private/sessions.json` holds only SHA-256 hashes of login tokens (the token itself is an HttpOnly, Secure, SameSite=Strict cookie limited to `/studio`). Every change request must come from the portal page itself (Origin check) as JSON.
- Adding or removing an artist from the site is still a code change (their page, nav link and homepage card live in the repo); the portal only manages logins for the artists in `gallery.json`.

PIN guessing is limited by `server/lib/lockout.js`:
- 5 wrong PINs lock that artist's login for 15 minutes; each further lockout doubles (30 min, 1 h, ... up to 24 h); a lockout-free day starts the doubling over.
- 10 wrong PINs from one IP within 15 minutes, across any artists, block that IP for an hour.
- While locked, the PIN isn't checked at all. Lock state is saved to disk, so a restart doesn't clear it. The admin can unlock an artist.

At that pace, guessing a 6-digit PIN would take centuries. Tests: `cd server && npm test`.

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
*/2 * * * * root /usr/bin/flock -n /run/borrowedtime-pull.lock /bin/bash /var/www/html/borrowedtime/server/auto-pull.sh >> /var/log/borrowedtime-pull.log 2>&1
```
So pushing to `main` is the whole deploy; it's live within ~2 minutes. `server/auto-pull.sh` pulls as ec2-user (who owns the checkout) and restarts the artist portal (`borrowedtime-portal`) only when `server/` changed, running `npm ci` first if its dependencies changed, so page-only pushes never interrupt an upload. Errors land in `/var/log/borrowedtime-pull.log`. To deploy by hand anyway: `sudo -u ec2-user git -C /var/www/html/borrowedtime pull`.

Not automatic: changes to `server/apache-portal.conf` need `sudo apachectl configtest && sudo systemctl reload httpd`, and changes to `server/borrowedtime-portal.service` need it copied to `/etc/systemd/system/` plus `sudo systemctl daemon-reload && sudo systemctl restart borrowedtime-portal`.

History: until 2026-11-20 the cron line ran a bare `git pull` as ec2-user with its lock in `/tmp`. The lock file must now be in `/run`: Linux won't let root open a file another user created in `/tmp`, and the leftover one stopped deploys for a few minutes until it was moved.

Apache config: the site's vhosts are in `/etc/httpd/conf/httpd.conf` (port 80, redirects to https) and `/etc/httpd/conf/httpd-le-ssl.conf` (443). Folder listings are off for every site via `/etc/httpd/conf.d/zz-no-indexes.conf` (`Options -Indexes` on `/var/www/html`, added 2026-10-15), so a folder URL like `/images/dexter/` returns 403; `.git/` and other dot-folders are blocked by `conf.d/deny-hidden.conf`.

### Traffic Guard (bandwidth cap)
`/etc/cron.d/traffic-guard` runs `/usr/local/bin/traffic-guard.sh` as root every 5 minutes. It adds up the server's network traffic (in + out) for the month in `/var/lib/traffic-guard/YYYY-MM` (bytes) and **stops Apache once the month passes 800 GB**, to stay under the Lightsail transfer allowance. Stopping Apache takes down every site on the box (borrowedtime, clarknavidad, ...), and nothing starts it again on its own, not even when the new month begins.
- Usage so far this month: `sudo awk '{printf "%.1f GB\n", $1/1024^3}' /var/lib/traffic-guard/$(date +%Y-%m)`
- Did it fire? `sudo journalctl -t traffic-guard` (it logs "stopped httpd")
- Bring the sites back: `sudo systemctl start httpd` (if it's still the same month, it'll stop again within 5 minutes unless `LIMIT_GB` in the script is raised)

The script must set `PATH=/usr/sbin:/usr/bin:/sbin:/bin` on line 2: cron's default PATH lacks `/usr/sbin`, where `ip` lives, and without it the script crashed every run and counted nothing (broken from setup on 2026-09-30 until fixed 2026-10-15; the pre-fix copy is `traffic-guard.sh.bak`). Check a run is clean with `sudo journalctl -u crond --since "10 min ago" | grep -i traffic` (no `CMDOUT` error lines). For scale: the whole box used ~12.5 GB from Sep 30 to Oct 15.

This is why big images matter: serve thumbnails and `images/web/` copies, never multi-MB originals on page load.

### CSS Cache Busting
The stylesheet is linked as `css/singlePageTemplate.css?v=N` (check any page for the current N). Whenever `singlePageTemplate.css` changes, bump the `?v=` number in every HTML file's `<link>` tag (all files listed above, plus `index.html`). Without this, returning visitors' browsers can keep serving a stale cached copy of the CSS after a deploy, since the file has no other cache-busting mechanism.

## Website Structure

### Artist Pages
- **Dexter** - Award-winning artist
- **Tomb Raider** - Floral specialist
- **Chris** - Detail perfectionist
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
- Category filtering on artist pages (buttons built from the artist's tags)
- Artist attribution and reference code in studio gallery lightboxes
- Before/after toggle in the lightbox for photos with a `before` shot

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
