#!/bin/bash
# Run every 2 minutes by /etc/cron.d/borrowedtime-pull (as root): pulls the site as ec2-user
# (who owns the checkout), and restarts the artist portal only when its code changed, so
# page-only updates never interrupt an upload.
PATH=/usr/sbin:/usr/bin:/sbin:/bin
SITE=/var/www/html/borrowedtime
as_owner() { runuser -u ec2-user -- "$@"; }

cd "$SITE" || exit 1
old=$(as_owner git rev-parse HEAD) || exit 1
as_owner git pull -q || exit 1
as_owner git diff --quiet "$old" HEAD -- server/ && exit 0

if ! as_owner git diff --quiet "$old" HEAD -- server/package.json server/package-lock.json; then
  (cd server && as_owner npm ci --omit=dev --no-audit --no-fund) || exit 1
fi
systemctl restart borrowedtime-portal
