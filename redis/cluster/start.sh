#!/usr/bin/env bash
# 6노드 클러스터 (master 3 + replica 3), 포트 7001-7006
#   pnpm redis:cluster        시작
#   pnpm redis:cluster:down   종료
set -euo pipefail
cd "$(dirname "$0")"
./stop.sh >/dev/null 2>&1 || true
mkdir -p run
NODES=()
for P in 7001 7002 7003 7004 7005 7006; do
  redis-server --port "$P" --cluster-enabled yes --cluster-config-file "$PWD/run/nodes-$P.conf" \
    --cluster-node-timeout 2000 --daemonize yes --dir "$PWD/run" --dbfilename "node-$P.rdb" \
    --pidfile "$PWD/run/$P.pid" --logfile "$PWD/run/$P.log" --save "" --appendonly no \
    --bind 127.0.0.1 --protected-mode no
  NODES+=("127.0.0.1:$P")
done
sleep 0.5
redis-cli --cluster create "${NODES[@]}" --cluster-replicas 1 --cluster-yes >/dev/null
sleep 1
redis-cli -p 7001 cluster info | grep -E "cluster_state|cluster_known_nodes" | tr -d '\r'
redis-cli -p 7001 cluster nodes | awk '{print $2, $3}' | sed 's/,.*//'
