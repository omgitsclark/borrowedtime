"""Generate square gallery thumbnails into images/thumbs/, mirroring images/<artist>/.

Run from the repo root after adding or changing artist photos:
    python tools/make_thumbnails.py

Only new or changed photos are processed. Requires Pillow (pip install pillow).
"""
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / "images"
THUMBS = IMAGES / "thumbs"
SKIP_DIRS = {"thumbs", "store"}
EXTENSIONS = {".jpg", ".jpeg"}
SIZE = 720
QUALITY = 75


def source_photos():
    for folder in sorted(p for p in IMAGES.iterdir() if p.is_dir() and p.name not in SKIP_DIRS):
        for photo in sorted(folder.rglob("*")):
            if photo.suffix.lower() in EXTENSIONS:
                yield photo


def main():
    made = skipped = 0
    for photo in source_photos():
        thumb = THUMBS / photo.relative_to(IMAGES)
        if thumb.exists() and thumb.stat().st_mtime >= photo.stat().st_mtime:
            skipped += 1
            continue
        thumb.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(photo) as im:
            # Bake in the phone's rotation tag; browsers honor it but a plain resize would not.
            im = ImageOps.exif_transpose(im).convert("RGB")
            # Center crop matches the grid's object-fit: cover, so thumbnails look identical.
            # Never upscale: small originals keep their own resolution.
            side = min(SIZE, *im.size)
            im = ImageOps.fit(im, (side, side), Image.LANCZOS, centering=(0.5, 0.5))
            im.save(thumb, "JPEG", quality=QUALITY, optimize=True, progressive=True)
        made += 1
    print(f"thumbnails created: {made}, already up to date: {skipped}")


if __name__ == "__main__":
    main()
