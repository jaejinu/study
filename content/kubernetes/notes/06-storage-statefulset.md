---
title: 스토리지와 StatefulSet
order: 6
level: 중급
summary: Volume·PV·PVC·StorageClass 의 관계, 동적 프로비저닝, 상태 있는 앱을 위한 StatefulSet — 이 프로젝트의 Redis 배포 해부
tags: [Volume, PV, PVC, StorageClass, StatefulSet, Redis]
experiments: []
---

## 컨테이너 파일시스템은 사라진다

Pod 이 재생성되면 컨테이너 안에 쓴 파일은 없어진다. Docker 의 볼륨처럼 Kubernetes 도 데이터를 Pod 밖에 둔다.

## Volume 의 종류

```yaml
volumes:
  - name: tmp
    emptyDir: {}                      # Pod 생명주기 동안만 (캐시, 임시 파일). medium: Memory 가능
  - name: config
    configMap: { name: redis-config } # ConfigMap/Secret
  - name: host
    hostPath: { path: /var/log }      # 노드의 경로 (DaemonSet 용, 운영 앱엔 비추천)
  - name: data
    persistentVolumeClaim: { claimName: data-redis-0 }   # 영속 스토리지
```

## PV, PVC, StorageClass

```
개발자            관리자 / 클라우드
  │                   │
  │ PVC "1Gi, RWO"    │ StorageClass "standard" (프로비저너: local-path / ebs / pd)
  │  ──────────────▶  │
  │                   ▼
  │                 PV (실제 디스크) ◀── 동적 프로비저닝으로 자동 생성
  │  ◀── Bound ──────┘
  ▼
 Pod 이 PVC 를 마운트
```

- **PersistentVolume(PV)**: 실제 스토리지 조각. 클러스터 자원.
- **PersistentVolumeClaim(PVC)**: "이만큼 필요하다" 는 요청. 네임스페이스 자원. Pod 은 PVC 만 안다.
- **StorageClass**: PVC 가 들어오면 PV 를 자동으로 만드는 방법(프로비저너)과 정책.

```bash
kubectl get storageclass                 # kind 는 'standard' (local-path-provisioner)
kubectl get pvc -n study
kubectl get pv
kubectl describe pvc data-redis-0 -n study
```

접근 모드: `ReadWriteOnce`(한 노드), `ReadOnlyMany`, `ReadWriteMany`(NFS 류만). 클라우드 블록 디스크(EBS)는 RWO 다.

**reclaimPolicy**: PVC 를 지웠을 때 PV 를 `Delete`(기본, 동적 프로비저닝)할지 `Retain` 할지. 운영 DB 는 Retain 을 고려.

## Deployment 로는 부족한 이유

Deployment 의 Pod 은 서로 구분이 없고(web-7d9f-abc, web-7d9f-xyz), 재생성되면 이름도 바뀐다. DB·Redis 처럼
- 각 복제본이 **고유한 정체성**(이름, 네트워크 ID)을 유지해야 하고
- 복제본마다 **자기 디스크**가 붙어야 하고
- **순서대로** 뜨고 내려가야 하는 (primary 먼저)
앱에는 **StatefulSet** 을 쓴다.

## StatefulSet 특징

- Pod 이름이 `redis-0`, `redis-1` 처럼 순번. 재생성돼도 같은 이름.
- `volumeClaimTemplates` 로 Pod 마다 PVC 를 자동 생성 (`data-redis-0`). **Pod 을 지워도 PVC 는 남는다.**
- Headless Service 와 함께 쓰면 `redis-0.redis.study.svc` 로 개별 Pod 에 접근 가능.
- 생성은 0→1→2 순서, 삭제는 역순. 업데이트도 역순으로 하나씩.

## 이 프로젝트의 `k8s/redis.yaml` 해부

```yaml
kind: StatefulSet
spec:
  serviceName: redis                # 연결될 Service 이름
  replicas: 1
  template:
    spec:
      containers:
        - name: redis
          image: redis:8-alpine
          args: [redis-server, /usr/local/etc/redis/redis.conf,
                 --dir, /data, --bind, "0.0.0.0", --protected-mode, "no"]
          volumeMounts:
            - { name: config, mountPath: /usr/local/etc/redis, readOnly: true }   # ConfigMap
            - { name: data, mountPath: /data }                                    # PVC
          resources:
            requests: { cpu: 50m, memory: 64Mi }
            limits: { memory: 320Mi }
          readinessProbe: { exec: { command: [redis-cli, ping] }, periodSeconds: 5 }
          livenessProbe:  { exec: { command: [redis-cli, ping] }, initialDelaySeconds: 10, periodSeconds: 10 }
      volumes:
        - name: config
          configMap: { name: redis-config }
  volumeClaimTemplates:
    - metadata: { name: data }
      spec:
        accessModes: [ReadWriteOnce]
        resources: { requests: { storage: 1Gi } }
```

Docker Compose 때와 같은 이유로 `--dir`, `--bind`, `--protected-mode` 를 인자로 넘긴다. `maxmemory 256mb` 보다 limit 을 넉넉히(320Mi) 둬서 OOMKill 을 피한다.

## 실습: 데이터가 Pod 을 넘어 살아남는지

```bash
pnpm k8s:up
kubectl -n study exec redis-0 -- redis-cli SET survive yes
kubectl -n study exec redis-0 -- redis-cli BGSAVE
kubectl -n study delete pod redis-0            # Pod 삭제
kubectl -n study get pods -w                   # redis-0 이 같은 이름으로 다시 뜬다
kubectl -n study exec redis-0 -- redis-cli GET survive     # "yes" — PVC 덕분
kubectl -n study get pvc                       # data-redis-0 그대로

pnpm k8s:down                                  # StatefulSet 삭제해도
kubectl -n study get pvc                       # PVC 는 남는다 (명시적으로 지워야 함)
kubectl -n study delete pvc data-redis-0
```

## 앱도 함께: `k8s/web.yaml`

이 사이트 자체는 무상태이므로 **Deployment** (replicas 2, RollingUpdate maxUnavailable 0) + Service 로 배포한다. 환경 변수 `REDIS_URL=redis://redis:6379` 가 같은 네임스페이스의 Redis Service 를 DNS 이름으로 가리킨다.

```bash
pnpm docker:build && pnpm k8s:load     # 이미지를 kind 노드에 넣는다 (레지스트리 없이)
pnpm k8s:up                            # redis StatefulSet + web Deployment
kubectl -n study get pods -o wide      # web Pod 2개 + redis-0
pnpm k8s:web:port                      # http://localhost:3200 — 클러스터 안의 Redis 에 연결된 대시보드
```

## Redis 를 k8s 에서 제대로 운영하려면

단일 StatefulSet 은 학습용이다. 실제로는:
- **Redis Operator** (Redis Enterprise, OpsTree, Spotahome) 로 Sentinel/Cluster 구성 자동화
- 또는 Bitnami Helm 차트 (`bitnami/redis`: master + replicas + sentinel 옵션)
- 또는 관리형 (ElastiCache, Memorystore) 을 쓰고 k8s 안에선 ExternalName Service 로 연결

## 실습 체크리스트

- [ ] `kubectl get pvc,pv` 로 동적 프로비저닝 결과 확인
- [ ] Pod 삭제 후 같은 이름·같은 데이터로 돌아오는지 확인
- [ ] `replicas: 2` 로 바꿔 `redis-1` 과 `data-redis-1` 이 생기는지 보기 (복제 설정은 없으니 독립 인스턴스)

## 관련 노트

- [Redis 고가용성](/redis/notes/11-replication-sentinel-cluster) — k8s 위의 Sentinel/Cluster 는 Operator 로
- [Docker 볼륨](/docker/notes/04-volumes-networks)
