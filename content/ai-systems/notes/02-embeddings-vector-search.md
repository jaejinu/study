---
title: 임베딩과 벡터 검색
order: 2
level: 기초
summary: 임베딩이 무엇이고 왜 비슷한 의미가 가까운 벡터가 되는지, 거리 척도, ANN 인덱스(HNSW·IVF·FLAT) 의 원리와 트레이드오프, 하이브리드 검색과 재정렬, Redis 8·pgvector 등 저장소 선택, 실험과 예시
tags: [임베딩, 벡터검색, HNSW, 코사인, ANN, hybrid, pgvector, Redis]
experiments: [vector-search-redis, semantic-cache]
---

## 임베딩

텍스트(또는 이미지)를 **고정 길이 실수 벡터**로 바꾸는 모델의 출력. 학습 과정에서 "비슷한 맥락에 나오는 것" 이 가까워지도록 훈련되어, 벡터 거리가 의미 유사도를 근사한다.

```
"Redis 파이프라인은 왜 빠른가"   → [0.021, -0.113, 0.087, …]  (1536차원)
"파이프라이닝이 처리량을 올리는 이유" → [0.019, -0.108, 0.091, …]   ← 가까움
"PostgreSQL 데드락 감지"          → [-0.074, 0.032, -0.150, …]   ← 멂
```

- 차원: 256~3072. 클수록 표현력↑, 저장·검색 비용↑. 많은 모델이 Matryoshka 로 앞부분만 잘라 써도 되게 훈련됨.
- **같은 모델로** 문서와 질의를 임베딩해야 한다. 모델을 바꾸면 전체 재인덱싱.
- 이 프로젝트 실험의 "가짜 임베딩" 은 단어·문자 3-gram 을 해시해 누적한 것(hashing trick). 의미는 모르지만 **인덱스·거리·KNN 의 역학**은 실제와 같다. `src/code-lab/ai.ts` 의 `embed()` 를 임베딩 API 호출로 바꾸면 그대로 실전 코드가 된다.

## 거리 척도

| 척도 | 식 | 언제 |
|---|---|---|
| **코사인** | 1 − (a·b)/(‖a‖‖b‖) | 텍스트 기본. 길이 무관, 방향만 |
| 내적 (IP) | −a·b | 정규화된 벡터면 코사인과 동일하고 더 빠름 |
| 유클리드 (L2) | ‖a−b‖ | 이미지·좌표 |

벡터를 **정규화(‖v‖=1)** 해 두면 코사인 = 내적. Redis 의 `score` 는 거리(0 이 같음)이고 유사도 = 1 − score.

## 정확 KNN vs 근사(ANN)

문서 100만 개 × 1536차원을 전부 비교하면 질의마다 수십 ms~초. **ANN 인덱스**는 정확도를 조금 포기하고 수 ms 로 만든다.

| 인덱스 | 원리 | 장단점 |
|---|---|---|
| **FLAT** | 전수 비교 | 100% 정확. 수만 개까지 |
| **HNSW** | 계층적 "작은 세상" 그래프를 탐색 | 빠르고 정확(recall 95%+). 메모리 많이 씀. 삽입 가능. 기본 선택 |
| IVF | 클러스터(centroid)로 나눠 가까운 몇 개만 탐색 | 메모리 적음. 학습 필요, 분포 바뀌면 재학습 |
| PQ / SQ | 벡터 압축(양자화) | 메모리 1/8~1/32. 정확도 손실 |

HNSW 파라미터: `M`(노드당 연결 수, 16~64), `EF_CONSTRUCTION`(빌드 시 탐색 폭, 200), `EF_RUNTIME`(질의 시 탐색 폭 — 높일수록 정확·느림). 질의 시 `EF_RUNTIME` 을 k 의 몇 배로.

```
FT.CREATE idx ON HASH PREFIX 1 doc: SCHEMA
  vec VECTOR HNSW 10 TYPE FLOAT32 DIM 1536 DISTANCE_METRIC COSINE M 32 EF_CONSTRUCTION 200 EF_RUNTIME 64
  subject TAG  title TEXT  created NUMERIC
FT.SEARCH idx "*=>[KNN 10 @vec $q AS score]" PARAMS 2 q <bytes> SORTBY score RETURN 2 title score DIALECT 2
```

## 필터와 하이브리드

- **메타데이터 필터**: `"@subject:{redis} @created:[1700000000 +inf] =>[KNN 10 @vec $q]"` — Redis 는 필터를 **먼저** 적용(pre-filter)해 필터 결과가 작으면 FLAT 로, 크면 HNSW 로 자동 전환. 필터가 매우 선택적이면 ANN 그래프에서 후보가 부족해지는 문제가 있어 pre-filter 가 유리.
- **하이브리드(키워드 + 벡터)**: 고유명사·코드·숫자는 임베딩이 약하다. BM25(전문 검색) 결과와 벡터 결과를 **RRF(Reciprocal Rank Fusion)** 로 합친다: `score = Σ 1/(60 + rank_i)`. Redis 8.2+ 는 `FT.HYBRID`, 그 전엔 두 질의 후 앱에서 합산.
- **재정렬(rerank)**: top-50 을 cross-encoder(질문+문서를 함께 읽는 모델)로 다시 점수화 → top-5. 정확도가 크게 오르고 비용은 50회 소형 추론.

## 저장소 선택

| 저장소 | 특징 |
|---|---|
| **Redis 8** | 이미 캐시로 쓰고 있다면 추가 인프라 0. HNSW/FLAT, 하이브리드, JSON 문서 인덱싱. 메모리 기반이라 수백만 벡터까지 |
| **pgvector** | PostgreSQL 안에서 `vector(1536)` 타입 + HNSW/IVFFlat 인덱스. 트랜잭션·조인과 함께. 수백만~천만 |
| Elasticsearch/OpenSearch | 전문 검색과 벡터를 한 엔진에. 운영 복잡 |
| 전용(Pinecone, Qdrant, Weaviate, Milvus) | 수억 벡터, 샤딩, 필터 최적화. 별도 운영/비용 |
| 파일(FAISS, sqlite-vec) | 단일 프로세스·배치·프로토타입 |

```sql
-- pgvector
CREATE EXTENSION vector;
CREATE TABLE chunks (id serial, doc text, body text, embedding vector(1536));
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 200);
SELECT doc, body, 1 - (embedding <=> $1) AS similarity FROM chunks ORDER BY embedding <=> $1 LIMIT 5;
```

## 운영 포인트

- **재인덱싱 전략**: 모델 교체 시 새 인덱스를 옆에 만들고 전환(블루/그린). 임베딩 버전을 메타데이터에.
- **갱신**: 문서 수정 시 청크 삭제·재삽입. HNSW 삭제는 마킹만 하므로 주기적 재빌드.
- **메모리**: 1536차원 float32 = 6KB/벡터 + HNSW 그래프. 100만 개 ≈ 8~10GB. float16/int8 양자화로 절감.
- **지연**: 임베딩 API 호출(50~200ms) 이 검색(수 ms) 보다 느리다 — 질의 임베딩 캐시(시맨틱 캐시 실험).
- **평가**: 평가셋(질문, 정답 청크)으로 recall@5 측정. 청킹·모델·하이브리드 변경 효과를 숫자로.

## 실험

- **벡터 검색** 실험: 노트 60편을 인덱싱하고 KNN·하이브리드 질의, 거리 해석.
- **시맨틱 캐시** 실험: 질문 임베딩으로 LLM 호출 절감과 오탐 위험.

## 실습 체크리스트

- [ ] 벡터 검색 실험에서 `EF_RUNTIME` 을 바꿔 결과·시간 차이 보기 (코드 수정)
- [ ] 필터 `@subject:{kafka}` 로 하이브리드 질의
- [ ] pgvector 를 PostgreSQL 컨테이너에 설치(`pgvector/pgvector:pg16` 이미지)하고 같은 데이터로 비교
- [ ] 평가셋 10개로 recall@5 를 계산하는 스크립트 작성
