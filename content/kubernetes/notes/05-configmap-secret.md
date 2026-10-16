---
title: ConfigMap 과 Secret
order: 5
level: 중급
summary: 설정을 이미지와 분리하는 두 오브젝트, 환경 변수 vs 파일 마운트, 변경 반영 방식, Secret 의 실제 보안 수준
tags: [ConfigMap, Secret, 환경변수, 볼륨, kustomize]
experiments: []
---

## 설정은 이미지 밖에

같은 이미지를 개발·스테이징·운영에서 쓰려면 설정이 밖에 있어야 한다.
- **ConfigMap**: 일반 설정 (문자열 key-value, 파일 통째)
- **Secret**: 비밀값 (base64 로 저장, RBAC 으로 접근 제한)

## ConfigMap 만들기

```bash
# 리터럴
kubectl create configmap app-config --from-literal=LOG_LEVEL=info --from-literal=REDIS_URL=redis://redis:6379
# 파일에서 (키 = 파일명)
kubectl create configmap redis-config --from-file=redis.conf=redis/redis.conf
kubectl get cm redis-config -o yaml
```

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: info
  REDIS_URL: redis://redis:6379
  app.properties: |            # 여러 줄 = 파일
    feature.x=true
```

## Pod 에서 쓰는 두 가지 방법

### 환경 변수로

```yaml
containers:
  - name: app
    envFrom:
      - configMapRef: { name: app-config }     # 모든 키를 환경 변수로
    env:
      - name: LOG_LEVEL
        valueFrom:
          configMapKeyRef: { name: app-config, key: LOG_LEVEL }
```

환경 변수는 **Pod 시작 시 고정**된다. ConfigMap 을 바꿔도 재시작 전까지 반영되지 않는다.

### 파일로 마운트

```yaml
containers:
  - name: redis
    volumeMounts:
      - name: config
        mountPath: /usr/local/etc/redis       # 디렉터리에 키 이름의 파일들이 생긴다
        readOnly: true
volumes:
  - name: config
    configMap:
      name: redis-config
      # items: [{ key: redis.conf, path: redis.conf }]   # 일부만
```

마운트된 파일은 ConfigMap 변경 후 **수십 초 내 자동 갱신**된다 (kubelet sync 주기). 단 `subPath` 로 마운트하면 갱신되지 않는다. 앱이 파일 변경을 감지해 다시 읽어야 의미가 있다. Redis 는 설정 파일을 시작 시 한 번만 읽으므로 재시작이 필요하다.

## 변경을 확실히 반영하는 법

1. `kubectl rollout restart deploy/app` — 수동 재시작.
2. **kustomize configMapGenerator** — 내용 해시를 이름에 붙인다 (`redis-config-9766kf847m`). 내용이 바뀌면 이름이 바뀌고, Pod 템플릿이 바뀌므로 자동 롤링 업데이트. 이 프로젝트의 `k8s/kustomization.yaml` 이 이 방식이다.
3. Pod 템플릿 annotation 에 ConfigMap 의 checksum 을 넣는 Helm 패턴.

```yaml
# k8s/kustomization.yaml
configMapGenerator:
  - name: redis-config
    files:
      - redis.conf=../redis/redis.conf
```

```bash
kubectl kustomize k8s | head -40          # 생성될 ConfigMap 이름 확인
```

## Secret

```bash
kubectl create secret generic redis-auth --from-literal=password='s3cret'
kubectl get secret redis-auth -o jsonpath='{.data.password}' | base64 -d
```

```yaml
apiVersion: v1
kind: Secret
metadata: { name: redis-auth }
type: Opaque
stringData:                  # 평문으로 쓰면 저장 시 base64 로 변환
  password: s3cret
```

사용법은 ConfigMap 과 같다 (`secretKeyRef`, `secret:` 볼륨).

### 실제 보안 수준

- base64 는 **암호화가 아니다**. `kubectl get secret -o yaml` 권한이 있으면 다 보인다.
- etcd 에 평문으로 저장된다 → **encryption at rest** 를 켜야 한다 (관리형 클러스터는 보통 기본).
- git 에 Secret 매니페스트를 그대로 올리지 말 것. **Sealed Secrets**, **SOPS**, **External Secrets Operator**(Vault/AWS Secrets Manager 연동) 중 하나를 쓴다.
- RBAC 으로 Secret 읽기 권한을 최소화.

### 특수 타입

| type | 용도 |
|---|---|
| `kubernetes.io/dockerconfigjson` | 사설 레지스트리 pull 인증 (`imagePullSecrets`) |
| `kubernetes.io/tls` | Ingress TLS 인증서 |
| `kubernetes.io/basic-auth` | |

```bash
kubectl create secret docker-registry ghcr --docker-server=ghcr.io --docker-username=U --docker-password=TOKEN
```

## 실습 체크리스트

- [ ] `kubectl get cm -n study -o yaml` 로 kustomize 가 만든 redis-config 내용 확인
- [ ] `redis/redis.conf` 의 `maxmemory` 를 바꾸고 `pnpm k8s:up` → ConfigMap 이름이 바뀌며 Pod 이 재생성되는지 `kubectl get pods -w` 로 관찰
- [ ] `kubectl exec redis-0 -- redis-cli config get maxmemory` 로 반영 확인
- [ ] Secret 을 만들고 base64 디코드해 보기
