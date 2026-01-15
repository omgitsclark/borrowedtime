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
cp chris.html chris && cp dexter.html dexter && cp tombraider.html tombraider && cp billythakidd.html billythakidd && cp gallery_animals.html gallery_animals && cp gallery_characters.html gallery_characters && cp gallery_color.html gallery_color && cp gallery_floral.html gallery_floral && cp gallery_japanese.html gallery_japanese && cp gallery_memorial.html gallery_memorial && cp gallery_realism.html gallery_realism && cp gallery_religious.html gallery_religious
```

**Why:** The live site serves both `/chris` and `/chris.html` URLs. The extensionless files need to stay in sync with the `.html` files.

## Website Structure

### Artist Pages
- **Dexter** - Award-winning artist
- **Tomb Raider** - Floral specialist
- **Chris** - Detail perfectionist
- **Billy tha Kidd** - Versatile artist (newest addition)

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
- Reference codes follow pattern: `[CATEGORY]-[ARTIST]-[NUMBER]` (e.g., `AN-B01` = Animals-Billy-01)
