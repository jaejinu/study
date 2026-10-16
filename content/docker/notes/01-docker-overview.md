---
title: Docker 란 무엇인가
order: 1
level: 기초
summary: 컨테이너가 VM 과 다른 점, 이미지·컨테이너·레지스트리의 관계, Docker 가 해결하는 문제
tags: [개요, 컨테이너, 이미지, 레지스트리, VM]
experiments: []
---

## 해결하려는 문제

"내 컴퓨터에서는 되는데요." 애플리케이션은 코드만으로 돌아가지 않는다. 런타임 버전, 시스템 라이브러리, 환경 변수, 설정 파일이 모두 맞아야 한다.
Docker 는 이 **전체 실행 환경을 하나의 이미지로 포장**해서 어디서든 같은 방식으로 실행하게 해 준다.

## 컨테이너 vs 가상 머신

| | 가상 머신 | 컨테이너 |
|---|---|---|
| 격리 단위 | 하드웨어 가상화, 게스트 OS 전체 | 프로세스. 호스트 커널 공유 |
| 크기 | 수 GB | 수십 MB ~ 수백 MB |
| 시작 시간 | 수십 초 ~ 분 | 밀리초 ~ 초 |
| 오버헤드 | 큼 (OS 하나 더) | 거의 없음 |
| 격리 강도 | 강함 | 상대적으로 약함 (커널 공유) |

컨테이너는 리눅스 커널 기능 위에 서 있다.
- **namespaces**: 프로세스가 보는 세계(PID, 네트워크, 마운트, 사용자)를 분리
- **cgroups**: CPU·메모리 사용량 제한
- **union filesystem** (overlay2): 이미지 레이어를 겹쳐서 하나의 파일시스템처럼

macOS/Windows 에서는 리눅스 커널이 없으므로 Docker Desktop 이 **경량 리눅스 VM** 을 하나 띄우고 그 안에서 컨테이너를 돌린다. 그래서 파일 마운트 성능이 리눅스보다 느리다.

## 세 가지 핵심 개념

```
Dockerfile  --build-->  Image  --run-->  Container
                          |
                     push / pull
                          |
                       Registry (Docker Hub, GHCR, ECR ...)
```

- **이미지(Image)**: 읽기 전용 템플릿. 파일시스템 레이어들 + 실행 방법(메타데이터). 클래스에 비유.
- **컨테이너(Container)**: 이미지를 실행한 인스턴스. 이미지 위에 쓰기 가능한 얇은 레이어가 얹힌다. 객체에 비유.
- **레지스트리(Registry)**: 이미지 저장소. `docker pull redis:8-alpine` 은 Docker Hub 의 `library/redis` 저장소에서 `8-alpine` 태그를 받는다.

이미지 이름 구조: `[registry/][namespace/]repository[:tag|@digest]`
```
redis                        = docker.io/library/redis:latest
ghcr.io/myorg/api:1.4.2
redis@sha256:ab12...         # 태그 대신 다이제스트로 고정
```

## Docker 의 구성 요소

- **Docker CLI** (`docker`): 사용자가 치는 명령.
- **Docker 데몬** (`dockerd`): 이미지 빌드, 컨테이너 실행을 실제로 수행. CLI 는 REST API 로 데몬과 통신한다.
- **containerd / runc**: 데몬 아래에서 실제 컨테이너 생명주기를 관리하는 저수준 런타임. Kubernetes 는 Docker 없이 containerd 를 직접 쓴다.

## 무엇에 쓰나

1. **개발 환경 통일**: 팀원 모두 같은 DB·캐시 버전을 `docker compose up` 한 번으로.
2. **배포 단위**: 빌드된 이미지를 그대로 스테이징·운영에. "빌드 한 번, 어디서나 실행".
3. **CI**: 깨끗한 환경에서 테스트.
4. **격리된 실험**: 이 프로젝트처럼 Redis 를 설치하지 않고 바로 띄워 보기.

## 이 노트 시리즈의 실습 방식

Docker 는 터미널에서 직접 명령을 치며 배우는 것이 가장 빠르다. 각 노트의 **실습** 블록을 그대로 따라 하자.
설치가 안 되어 있다면:

```bash
brew install --cask docker    # Docker Desktop (GUI 포함)
# 또는
brew install orbstack         # 더 가볍고 빠름, 명령 호환
docker version                # Client 와 Server 둘 다 나오면 준비 완료
```

대시보드의 환경 점검 카드가 데몬 연결 여부와 실행 중인 컨테이너를 보여준다.
