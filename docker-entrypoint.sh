#!/bin/sh
set -eu

# Production must never serve traffic against a schema that has not been migrated.
# Fail hard here so the process (and Docker restart policy) does not reach app.listen.
echo "Running database migrations before server start..."
node ./dist/scripts/migrate.js

echo "Migrations complete — starting server: $*"
exec "$@"
