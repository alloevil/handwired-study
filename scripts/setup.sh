#!/usr/bin/env bash
# Clone chenglou/handwired at the pinned commit into vendor/handwired (read-only use) and install its deps.
set -euo pipefail
COMMIT=257856e3b221140acb4cc4460626b850c0bd4ff1
cd "$(dirname "$0")/.."
if [ ! -d vendor/handwired/.git ]; then
  mkdir -p vendor
  git clone --filter=blob:none https://github.com/chenglou/handwired.git vendor/handwired
fi
git -C vendor/handwired fetch --quiet origin "$COMMIT" || true
git -C vendor/handwired -c advice.detachedHead=false checkout --quiet "$COMMIT"
echo "handwired at $(git -C vendor/handwired rev-parse HEAD)"
(cd vendor/handwired && bun install --frozen-lockfile)
