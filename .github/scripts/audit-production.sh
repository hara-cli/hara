#!/usr/bin/env bash
set -euo pipefail

# npm 10 falls back to the retired "audits/quick" endpoint when a bulk advisory request has a
# transient failure. Retry the complete audit instead of treating that fallback failure as either a
# clean audit or a permanent release failure. Every attempt still has to receive a real audit result.
max_attempts=3
retry_delay_seconds="${HARA_AUDIT_RETRY_DELAY_SECONDS:-5}"

for attempt in $(seq 1 "$max_attempts"); do
  if npm audit --omit=dev --registry https://registry.npmjs.org/; then
    exit 0
  else
    status=$?
  fi

  if [ "$attempt" -eq "$max_attempts" ]; then
    echo "production dependency audit failed after $max_attempts attempts" >&2
    exit "$status"
  fi

  echo "production dependency audit attempt $attempt failed; retrying in ${retry_delay_seconds}s" >&2
  sleep "$retry_delay_seconds"
done
