#!/usr/bin/env bash
cd "$(dirname "$0")"
for F in run/*.pid; do
  [[ -f "$F" ]] && kill "$(cat "$F")" 2>/dev/null || true
done
for P in 6381 6382 6383 26381 26382 26383; do redis-cli -p "$P" shutdown nosave >/dev/null 2>&1 || true; done
rm -rf run
echo "stopped"
