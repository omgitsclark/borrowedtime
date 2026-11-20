#!/bin/bash
# Run every 2 minutes by /etc/cron.d/borrowedtime-pull (as root): pulls the site as ec2-user
# (who owns the checkout), and restarts the artist portal only when its code changed, so
# page-only updates never interrupt an upload.
#
# Two stamp files remember what was last set up, so a step that fails (say, npm can't reach
# the registry) is tried again on the next run instead of being forgotten:
#   server/node_modules/.lock-stamp      copy of the package-lock.json last installed
#   /run/borrowedtime-portal.rev         git tree id of server/ the portal was last started with
PATH=/usr/sbin:/usr/bin:/sbin:/bin
SITE=/var/www/html/borrowedtime
REV_STAMP=/run/borrowedtime-portal.rev
as_owner() { runuser -u ec2-user -- "$@"; }

cd "$SITE" || exit 1
as_owner git pull -q || exit 1

if ! cmp -s server/package-lock.json server/node_modules/.lock-stamp; then
  echo "$(date '+%F %T') installing portal dependencies"
  (cd server && as_owner npm ci --omit=dev --no-audit --no-fund) || exit 1
  as_owner cp server/package-lock.json server/node_modules/.lock-stamp
fi

rev=$(as_owner git rev-parse HEAD:server) || exit 1
if [ "$(cat "$REV_STAMP" 2>/dev/null)" != "$rev" ]; then
  echo "$(date '+%F %T') restarting the portal for server/ $rev"
  systemctl restart borrowedtime-portal && echo "$rev" > "$REV_STAMP"
fi
