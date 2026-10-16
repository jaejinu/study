#!/usr/bin/env bash
# master 6381 + replica 6382, 6383 + sentinel 26381, 26382, 26383 (quorum 2)
#   pnpm redis:ha        시작
#   pnpm redis:ha:down   종료
set -euo pipefail
cd "$(dirname "$0")"
./stop.sh >/dev/null 2>&1 || true
mkdir -p run
./node.sh 6381
sleep 0.3
./node.sh 6382 6381
./node.sh 6383 6381
for P in 26381 26382 26383; do
  cat > "run/sentinel-$P.conf" <<CONF
port $P
bind 127.0.0.1
dir $PWD/run
pidfile $PWD/run/$P.pid
logfile $PWD/run/$P.log
daemonize yes
sentinel monitor mymaster 127.0.0.1 6381 2
sentinel down-after-milliseconds mymaster 1000
sentinel failover-timeout mymaster 5000
sentinel parallel-syncs mymaster 1
sentinel announce-ip 127.0.0.1
CONF
  redis-server "run/sentinel-$P.conf" --sentinel
done
sleep 1.5
echo "master 6381 / replicas 6382 6383 / sentinels 26381 26382 26383"
redis-cli -p 6381 INFO replication | grep -E "^role|connected_slaves" | tr -d '\r'
redis-cli -p 26381 SENTINEL get-master-addr-by-name mymaster | tr '\n' ':' ; echo
