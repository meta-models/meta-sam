#!/usr/bin/env bash
# Copyright (c) Meta Platforms, Inc. and affiliates. All Rights Reserved.
# Runs a command up to three times with backoff. CI installs that reach apt
# mirrors (Playwright --with-deps, ffmpeg) fail transiently on mirror hiccups
# ("Hash Sum mismatch", 403 from packages.microsoft.com); a retry after
# clearing apt's lists is enough. A persistent failure must not be masked, so
# the last attempt's exit status is returned unchanged.
set -u
attempts=3
delay="${CI_RETRY_DELAY:-20}"
status=0
for attempt in $(seq 1 "$attempts"); do
  "$@"
  status=$?
  if [ "$status" -eq 0 ]; then
    exit 0
  fi
  if [ "$attempt" -eq "$attempts" ]; then
    echo "ci-retry: '$*' failed ${attempts} times (last exit ${status})." >&2
    exit "$status"
  fi
  echo "ci-retry: attempt ${attempt} of ${attempts} failed (exit ${status}); retrying in ${delay}s." >&2
  if command -v apt-get >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
    sudo -n apt-get clean >/dev/null 2>&1 || true
    sudo -n rm -rf /var/lib/apt/lists/* >/dev/null 2>&1 || true
  fi
  sleep "$delay"
  delay=$((delay * 2))
done
