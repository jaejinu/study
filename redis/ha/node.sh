#!/usr/bin/env bash
# 복제 실습용 Redis 노드 하나를 백그라운드로 띄운다.
#   redis/ha/node.sh <port>                 # master
#   redis/ha/node.sh <port> <master-port>   # replica
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p run
PORT="$1"; MASTER="${2:-}"
ARGS=(--port "$PORT" --daemonize yes --dir "$PWD/run" --dbfilename "node-$PORT.rdb"
      --pidfile "$PWD/run/$PORT.pid" --logfile "$PWD/run/$PORT.log"
      --save "" --appendonly no --replica-announce-ip 127.0.0.1 --protected-mode no --bind 127.0.0.1)
if [[ -n "$MASTER" ]]; then ARGS+=(--replicaof 127.0.0.1 "$MASTER"); fi
redis-server "${ARGS[@]}"
