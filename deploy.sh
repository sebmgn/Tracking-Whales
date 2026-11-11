#!/bin/bash
# Puts positions.html online — the only way to deploy the site.
#   ./deploy.sh          tests, git push, upload, cache purge, live check
#   ./deploy.sh --check  tests only
# Stops at the first problem: nothing goes online if a test fails or if
# positions.html has changes that are not committed.
set -euo pipefail
cd "$(dirname "$0")"

BUCKET="tracking-whales-site"
DISTRIBUTION="E1WOC9Y73HSO45"
SITE="https://d10c6trxs5p3hy.cloudfront.net/"

echo "▶ Tests des calculs"
[ -d tests/node_modules ] || (cd tests && npm install --silent)
# not piped: the runner's exit code is the verdict
node --test --test-force-exit --test-timeout=60000 tests/calc.test.mjs
[ "${1:-}" = "--check" ] && { echo "✓ Tests passés (rien n'a été déployé)"; exit 0; }

if ! git diff --quiet HEAD -- positions.html; then
  echo "✗ positions.html a des modifications non commitées : commit d'abord, pour que le site en ligne corresponde à un commit." >&2
  exit 1
fi

echo "▶ git push"
git push origin main

echo "▶ Envoi vers S3"
# no-cache: the browser asks whether the page changed (304) instead of
# downloading it again; without the flag the header is lost on upload.
aws s3 cp positions.html "s3://$BUCKET/index.html" --cache-control "no-cache" --content-type "text/html" --only-show-errors
aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" --paths "/*" --query 'Invalidation.Id' --output text

echo "▶ Vérification du site en ligne"
for i in $(seq 1 18); do
  if curl -s -m 20 --compressed "$SITE" | cmp -s - positions.html; then
    echo "✓ En ligne : $SITE sert le commit $(git rev-parse --short HEAD)"
    exit 0
  fi
  sleep 5
done
echo "✗ Après 90 s, le site en ligne ne correspond toujours pas à positions.html — à vérifier." >&2
exit 1
