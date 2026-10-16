#!/usr/bin/env bash
cd "$(dirname "$0")"
for F in run/*.pid; do
  [[ -f "$F" ]] && kill "$(cat "$F")" 2>/dev/null || true
done
for P in 7001 7002 7003 7004 7005 7006; do redis-cli -p "$P" shutdown nosave >/dev/null 2>&1 || true; done
rm -rf run
echo "stopped"
