---
title: "심화 — CRD 와 Operator: Kubernetes 를 확장하는 방법"
order: 11
level: 심화
summary: 컨트롤러 조정 루프의 실제 구조(watch·큐·reconcile·status), CRD 로 새 리소스 타입을 정의하는 법, Operator 가 하는 일(Prometheus·Redis·PostgreSQL Operator 예), kubebuilder 로 작은 Operator 를 만드는 흐름, 멱등 reconcile 과 finalizer, Operator 를 쓸지 말지 판단
tags: [CRD, Operator, 컨트롤러, reconcile, kubebuilder, finalizer]
experiments: [k8s-self-healing]
---

## 모든 것은 컨트롤러다

Deployment 가 Pod 을 복구하는 것도, HPA 가 복제본을 바꾸는 것도 **컨트롤러**가 한다. 구조는 전부 같다.

```
         watch (API 서버, 변경 이벤트)
             │
      워크 큐 (객체 키 "ns/name", 중복 제거, 재시도 백오프)
             │
      reconcile(key):
         현재 상태 읽기 (캐시된 informer) → 원하는 상태(spec) 와 비교 → 차이만큼 생성/수정/삭제 → status 갱신
         실패하면 에러 반환 → 큐가 백오프 후 재시도
```

핵심 성질:
- **레벨 기반**(edge 아님): "무슨 이벤트가 왔나" 가 아니라 "지금 상태가 어떤가" 로 동작. 이벤트를 놓쳐도 다음 reconcile 에서 맞춘다 — [자가 치유 실험](/kubernetes/lab/k8s-self-healing)이 이 성질의 증거.
- **멱등**: 같은 입력에 reconcile 을 100번 해도 결과 동일. 이미 있으면 만들지 않고, 다르면 패치.
- **status 는 컨트롤러만 쓴다**, spec 은 사용자만.

## CRD — 새 리소스 타입

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata: { name: rediscaches.study.dev }
spec:
  group: study.dev
  names: { kind: RedisCache, plural: rediscaches, singular: rediscache, shortNames: [rc] }
  scope: Namespaced
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources: { status: {} }                 # status 를 별도 엔드포인트로 (RBAC 분리)
      additionalPrinterColumns:
        - { name: Size, type: string, jsonPath: .spec.memory }
        - { name: Ready, type: string, jsonPath: .status.ready }
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              required: [memory]
              properties:
                memory: { type: string, pattern: "^[0-9]+(Mi|Gi)$" }
                replicas: { type: integer, minimum: 1, maximum: 5, default: 1 }
                persistence: { type: boolean, default: true }
            status:
              type: object
              properties:
                ready: { type: string }
                observedGeneration: { type: integer }
```

```bash
kubectl apply -f crd.yaml
cat <<'Y' | kubectl apply -f -
apiVersion: study.dev/v1alpha1
kind: RedisCache
metadata: { name: sessions, namespace: study }
spec: { memory: 256Mi, replicas: 2 }
Y
kubectl get rc -n study          # CRD 만으로도 저장·조회·검증(스키마)·출력 컬럼이 된다. 아직 아무 일도 안 일어난다
kubectl explain rediscache.spec
```

CRD 는 **데이터 모델**이고, 동작은 **Operator(컨트롤러)** 가 붙어야 생긴다.

## Operator 가 하는 일 — 예

| Operator | CRD | reconcile 이 만드는 것 | 운영 지식 |
|---|---|---|---|
| Prometheus Operator | Prometheus, ServiceMonitor, PrometheusRule | StatefulSet, ConfigMap(생성된 prometheus.yml), Secret | 설정 재로드, 샤딩, 규칙 검증 ([k8s 관측 노트](/kubernetes/notes/10-monitoring-stack)) |
| Redis Operator (OpsTree/Spotahome) | RedisCluster, RedisSentinel | StatefulSet, Service, ConfigMap | 클러스터 초기화, 슬롯 재분배, failover, 백업 |
| CloudNativePG | Cluster, Backup, ScheduledBackup | Pod(직접 관리), PVC, Service(rw/ro) | 스위치오버, WAL 아카이브, PITR, 롤링 마이너 업그레이드 |
| cert-manager | Certificate, Issuer | Secret(TLS) | ACME 발급·갱신 |
| ArgoCD | Application | 매니페스트 전체 | git 동기화, 헬스 평가 |
| KEDA | ScaledObject | HPA | 외부 메트릭 스케일러 |

Operator = "사람이 런북 보고 하던 운영 작업을 코드로". Day-2 운영(백업, 업그레이드, 장애 조치)을 자동화할 때 가치가 있다.

## 작은 Operator 만들기 (kubebuilder)

```bash
kubebuilder init --domain study.dev --repo study.dev/redis-operator
kubebuilder create api --group cache --version v1alpha1 --kind RedisCache --resource --controller
make manifests install          # CRD 생성·설치
make run                        # 로컬에서 컨트롤러 실행 (kubeconfig 사용)
```

```go
// controllers/rediscache_controller.go (요지)
func (r *RedisCacheReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var rc cachev1alpha1.RedisCache
    if err := r.Get(ctx, req.NamespacedName, &rc); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)        // 삭제됐으면 할 일 없음
    }
    // 1) 원하는 StatefulSet 을 spec 으로부터 계산 (순수 함수)
    desired := buildStatefulSet(&rc)
    ctrl.SetControllerReference(&rc, desired, r.Scheme)         // ownerReference → RedisCache 삭제 시 GC
    // 2) 있으면 패치, 없으면 생성 (멱등)
    if err := r.Patch(ctx, desired, client.Apply, client.ForceOwnership, client.FieldOwner("redis-operator")); err != nil {
        return ctrl.Result{}, err                                 // 에러 → 백오프 재시도
    }
    // 3) 관찰한 상태를 status 에
    rc.Status.Ready = fmt.Sprintf("%d/%d", readyReplicas, rc.Spec.Replicas)
    rc.Status.ObservedGeneration = rc.Generation
    if err := r.Status().Update(ctx, &rc); err != nil { return ctrl.Result{}, err }
    return ctrl.Result{RequeueAfter: time.Minute}, nil            // 주기적 재확인
}
func (r *RedisCacheReconciler) SetupWithManager(mgr ctrl.Manager) error {
    return ctrl.NewControllerManagedBy(mgr).For(&cachev1alpha1.RedisCache{}).Owns(&appsv1.StatefulSet{}).Complete(r)
    // Owns: 소유한 StatefulSet 이 바뀌어도 reconcile 트리거
}
```

- **Server-Side Apply**(`client.Apply`) 로 "내가 관리하는 필드만" 선언적으로 패치 — 다른 컨트롤러·사용자가 바꾼 필드와 충돌하지 않는다.
- **ownerReference** 로 부모 삭제 시 자식이 가비지 컬렉션된다.
- **finalizer**: 외부 자원(클라우드 디스크, 외부 DNS)을 정리해야 하면 `metadata.finalizers` 에 이름을 넣어 두고, 삭제 요청 시 정리 후 finalizer 를 제거해야 실제 삭제된다.
- 다른 언어: Go(controller-runtime 표준), Python(kopf), Java(Operator SDK), Rust(kube-rs). Helm/Ansible 기반 Operator SDK 로 코드 없이도 가능.

## 설계 원칙

- spec 은 사용자의 **의도**만(복제본 수, 버전). 구현 세부(어느 노드, 어느 PVC)는 status 나 하위 리소스에.
- reconcile 은 짧고 멱등하게. 긴 작업(백업)은 Job 을 만들고 status 로 추적.
- 조건(`status.conditions[]`: Ready, Progressing, Degraded) 표준 형식을 쓰면 `kubectl wait --for=condition=Ready` 가 된다.
- 버전 업그레이드: 여러 `versions` + conversion webhook. `storage: true` 는 하나.
- admission webhook 으로 검증·기본값(CRD 스키마로 안 되는 규칙).
- 메트릭(reconcile 횟수·지연·에러)과 이벤트(`kubectl describe` 의 Events)를 남긴다.

## Operator 를 쓸까?

| 상황 | 선택 |
|---|---|
| 무상태 앱 배포 | Deployment + Helm/Kustomize. Operator 불필요 |
| 상태 있는 미들웨어(DB, Redis, Kafka)를 직접 운영 | 검증된 Operator 사용 (직접 만들지 말 것) |
| 조직 고유 플랫폼 추상화("우리 서비스 하나 = CRD 하나") | 자체 Operator 또는 Crossplane/Kratix |
| 관리형 서비스가 있다 | 관리형 + ExternalName/External Secrets. Operator 보다 쉽다 |

## 실습 체크리스트

- [ ] 위 CRD 를 kind 에 적용하고 `kubectl get rc`, `kubectl explain` 으로 스키마·출력 컬럼 확인
- [ ] 잘못된 `memory: 256` 로 apply 해 스키마 검증 에러 보기
- [ ] `kubectl get prometheus -n monitoring -o yaml` 로 Operator 가 관리하는 CR 의 spec/status 읽기, 소유한 StatefulSet 의 ownerReferences 확인
- [ ] (Go 환경이 있다면) kubebuilder 로 RedisCache Operator 뼈대를 만들고 `make run` 으로 로그 보기
