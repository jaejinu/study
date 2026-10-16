---
title: "파일시스템과 I/O — write() 에서 디스크 섹터까지"
order: 4
level: 중급
summary: "VFS 와 inode·dentry·파일 디스크립터의 관계, 하드 링크·삭제된 열린 파일, 저널링 파일시스템(ext4·XFS)이 크래시 일관성을 지키는 방법과 data=ordered, 블록 계층과 I/O 스케줄러(none·mq-deadline·bfq), 버퍼드 I/O·O_DIRECT·mmap 의 차이, fsync·fdatasync·O_SYNC 의 의미와 '쓰기가 성공했다' 의 진짜 뜻, 디렉터리 fsync 와 원자적 rename 패턴, overlayfs 와 컨테이너 쓰기 계층, iostat·/proc/diskstats 읽기, 이 VM 실측(4KiB O_DIRECT 요청당 28µs)"
tags: [파일시스템, VFS, inode, 저널링, ext4, I/O 스케줄러, O_DIRECT, fsync, mmap, overlayfs, iostat]
experiments: [os-page-cache]
---

## 경로 하나에 숨어 있는 구조

`open("/data/appendonly.aof", O_WRONLY|O_APPEND)` 한 줄 뒤에서 커널은 여러 층을 지난다.

```
유저 공간   fd = 3 ──────────────────────────────┐
───────────────────────────────────────────────── │
VFS        파일 디스크립터 표 → struct file (오프셋, 플래그)
                                 → dentry (이름 → inode 캐시)
                                 → inode (메타데이터: 크기, 권한, 블록 위치)
           페이지 캐시 (파일 내용)
───────────────────────────────────────────────── 
파일시스템  ext4 / XFS / overlayfs / tmpfs — 블록 할당, 저널
블록 계층   I/O 요청 병합·정렬, 스케줄러, 다중 큐
드라이버    NVMe / virtio-blk / SCSI
장치        SSD 컨트롤러 (FTL, 쓰기 캐시)
```

**VFS**(Virtual File System)는 모든 파일시스템이 같은 인터페이스(`read`, `write`, `fsync` …)로 보이게 하는 추상 계층이다. `/proc`, `/sys`, 소켓, 파이프도 VFS 위의 "파일" 이라서 `cat /proc/meminfo` 가 된다.

## inode, 이름, 파일 디스크립터

| 개념 | 무엇 | 확인 |
|---|---|---|
| **inode** | 파일의 실체: 크기, 권한, 소유자, 시각, 데이터 블록 위치. **이름은 없다** | `stat file`, `ls -i` |
| **dentry** | 디렉터리 안의 이름 → inode 번호 | `ls -la` |
| **파일 디스크립터** | 프로세스가 연 파일의 번호 → struct file → inode | `ls -l /proc/<pid>/fd` |

이 구조에서 나오는 실무 현상:

- **하드 링크**는 같은 inode 를 가리키는 이름 두 개. inode 의 링크 수가 0 이 되어야 지워진다.
- **지웠는데 디스크가 안 줄어든다**: `rm` 은 이름(링크)만 지운다. 어떤 프로세스가 열고 있으면 inode 와 데이터는 남는다. 로그 파일을 `rm` 했는데 공간이 그대로면 `lsof +L1`(링크 수 0 인 열린 파일)로 찾고 프로세스를 재시작(또는 로그 재오픈 시그널)한다.
- **inode 고갈**: 작은 파일 수백만 개면 공간이 남아도 inode 가 바닥난다. `df -i`.

## 저널링 — 크래시에도 깨지지 않게

파일 하나를 늘리는 쓰기는 여러 블록을 바꾼다(데이터 블록, inode 의 크기, 블록 비트맵). 그 중간에 전원이 나가면? **저널**(쓰기 전 로그)이 답이다. DB 의 WAL 과 같은 아이디어다([DB 내부 — WAL](/db-internals/notes/04-wal-checkpoint-recovery)).

| ext4 모드 | 저널에 쓰는 것 | 보장 |
|---|---|---|
| `data=journal` | 메타데이터 + 데이터 | 가장 안전, 쓰기 2배 |
| **`data=ordered`** (기본) | 메타데이터만, 단 데이터를 먼저 디스크에 | 크래시 후 새 메타데이터가 쓰레기 데이터를 가리키지 않는다 |
| `data=writeback` | 메타데이터만, 순서 보장 없음 | 빠르지만 크래시 후 파일 끝에 옛 데이터가 보일 수 있다 |

저널은 **파일시스템 자체의 일관성**을 지킨다. **애플리케이션 데이터가 디스크에 있다는 보장은 아니다** — 그건 `fsync` 의 일이다.

## 블록 계층과 I/O 스케줄러

```bash
cat /sys/block/vda/queue/scheduler     # [none] mq-deadline kyber bfq
cat /sys/block/vda/queue/read_ahead_kb # 128
```

| 스케줄러 | 언제 |
|---|---|
| **none** | NVMe·가상 디스크 — 장치가 이미 깊은 큐와 자체 스케줄링을 가짐. 대부분의 클라우드 기본 |
| mq-deadline | 회전 디스크·SATA SSD — 요청 기아 방지, 읽기 우선 |
| bfq | 데스크톱 — 프로세스별 공정성 |

## 세 가지 읽기·쓰기 방식

| 방식 | 경로 | 장점 | 단점 |
|---|---|---|---|
| **버퍼드 I/O** (기본) | 페이지 캐시 경유 | 캐시·readahead·쓰기 지연 병합이 공짜 | 복사 1회, 캐시가 메모리를 씀, 쓰기 시점이 불확실 |
| **O_DIRECT** | 캐시 우회, 정렬된 버퍼로 장치 직접 | 이중 캐싱 없음, 예측 가능한 메모리 | 정렬 제약(블록 크기 배수), readahead 없음 — 직접 관리해야 한다 |
| **mmap** | 파일을 주소 공간에 매핑, 접근 시 페이지 폴트로 로드 | 복사 없음, 랜덤 접근 편함 | 오류가 시그널(SIGBUS)로, 쓰기 시점 제어 어려움, 큰 파일에서 TLB 압박 |

- PostgreSQL 은 버퍼드 I/O + 자체 shared_buffers(이중 캐싱을 감수하고 OS 캐시를 2차 캐시로 활용).
- InnoDB·많은 상용 DB 는 O_DIRECT + 자체 버퍼 풀.
- LMDB·일부 검색 엔진(Lucene 의 MMapDirectory)은 mmap — OpenSearch 가 힙 외 메모리를 많이 남겨 두라고 하는 이유([OpenSearch 운영](/opensearch/notes/06-operations)).

## fsync — "성공" 의 진짜 의미

| 호출 | 기다리는 것 |
|---|---|
| `write()` 반환 | 페이지 캐시에 들어감. **디스크 아님** |
| `fdatasync(fd)` | 그 파일의 데이터 + 읽는 데 필요한 메타데이터(크기) |
| `fsync(fd)` | 데이터 + 모든 메타데이터(시각 포함) |
| `O_SYNC`/`O_DSYNC` 로 열기 | 매 write 마다 위 동작 |
| `sync()` | 시스템 전체 Dirty 를 내려 쓰기 시작(반환이 완료 보장은 아님) |

그리고 장치에도 **쓰기 캐시**가 있다. `fsync` 는 커널이 장치에 **플러시 명령(FUA/flush)** 까지 보내야 진짜다. 전원 보호 캐시(PLP)가 없는 소비자 SSD·일부 가상 디스크는 이 지점에서 거짓말을 할 수 있다. macOS 의 `fsync` 는 장치 캐시를 비우지 않고 `F_FULLFSYNC` 가 진짜인 것도 같은 문제다([디스크·메모리 계층](/db-internals/notes/01-disk-memory-hierarchy)).

### 파일을 원자적으로 바꾸는 법

설정 파일을 덮어쓰다 죽으면 반쯤 쓰인 파일이 남는다. 정석 패턴:

```c
fd = open("config.tmp", O_WRONLY|O_CREAT|O_TRUNC);
write(fd, data, len);
fsync(fd);                       // 1. 새 내용을 디스크에
close(fd);
rename("config.tmp", "config");  // 2. 이름 바꾸기는 원자적
dfd = open(".", O_RDONLY);
fsync(dfd);                      // 3. 디렉터리도 fsync — 이름 변경 자체를 내구성 있게
```

3번을 빠뜨리면 크래시 후 rename 이 사라질 수 있다. Redis 의 AOF 재작성과 RDB 저장도 임시 파일에 쓰고 rename 하는 같은 패턴이다([Redis 영속성](/redis/notes/04-persistence)).

## 컨테이너의 파일시스템: overlayfs

컨테이너 루트 파일시스템은 **overlayfs** 다. 읽기 전용 이미지 레이어들(lowerdir) 위에 컨테이너 전용 쓰기 레이어(upperdir)를 겹친다.

- 이미지 레이어의 파일을 처음 수정하면 **copy-up**: 파일 전체를 upperdir 로 복사한 뒤 수정한다. 큰 파일의 1바이트 수정이 GB 복사가 된다.
- 파일 삭제는 whiteout 표시 — 이미지 크기는 줄지 않는다([Docker 이미지·레이어](/docker/notes/03-images-dockerfile)).
- overlayfs 는 일부 기능(O_DIRECT 등)에 제약이 있다. 그래서 DB·로그처럼 쓰기가 많은 경로는 **볼륨**(호스트의 실제 파일시스템)으로 빼는 것이 원칙이다. 실험 `os-page-cache` 가 named volume 을 만드는 이유다.

## I/O 를 관측하는 법

```bash
iostat -x 1          # r/s w/s rkB/s wkB/s r_await w_await aqu-sz %util
cat /proc/diskstats  # 위 숫자의 원천 (누적 카운터)
cat /proc/pressure/io   # PSI: I/O 를 기다리며 막힌 시간 비율
```

| 지표 | 의미 | 주의 |
|---|---|---|
| `r_await`/`w_await` | 요청당 평균 지연(큐 대기 + 서비스) | 지연의 1차 신호 |
| `aqu-sz` | 평균 큐 깊이 | NVMe 는 깊은 큐가 정상 |
| `%util` | 장치가 바쁜 시간 비율 | **병렬 장치(SSD)에선 100% 여도 여유가 있을 수 있다** |

요청 단위로 보려면 eBPF 의 `biolatency`·`biosnoop` 이 히스토그램과 프로세스별 I/O 를 준다([BCC/libbpf 도구](/ebpf/notes/03-bcc-libbpf-tools)).

## 예시로 보기 — 이 프로젝트에서

실험 `os-page-cache` 의 4 KiB 순차 읽기(64 MiB, Docker VM 의 ext4 볼륨):

| 방식 | 처리량 | 요청당 |
|---|---|---|
| 버퍼드, 첫 읽기 | 3.4 GB/s | 1.2 µs |
| 버퍼드, 두 번째 (캐시) | 4.9 GB/s | 0.8 µs |
| O_DIRECT | 148 MB/s | **28 µs** |

O_DIRECT 의 28 µs 가 "가상 디스크(virtio-blk)까지 요청 하나 왕복" 의 비용이다. 버퍼드 첫 읽기가 그보다 20배 이상 빠른 것은 readahead 가 128 KiB 씩 미리 큰 요청으로 읽어 두기 때문이다 — 순차 접근에서 커널이 해 주는 일을 O_DIRECT 를 쓰면 애플리케이션이 직접 해야 한다.

1 MiB 블록으로 읽으면 반대로 O_DIRECT 가 가장 빨랐다(8.8 GB/s vs 캐시 5.8 GB/s). 큰 요청 하나의 고정 비용이 작아지고, 버퍼드 읽기는 페이지 캐시 → 유저 버퍼 복사를 한 번 더 하기 때문이다. **블록 크기에 따라 승자가 바뀐다** — DB 가 페이지 크기와 I/O 크기를 신중히 고르는 이유다.

## 실습 체크리스트

- [ ] 실험 `os-page-cache` 의 1 MiB·4 KiB 결과를 비교하고 "왜 블록 크기에 따라 O_DIRECT 의 순위가 바뀌는지" 한 문단으로 설명하기
- [ ] `docker run --rm --privileged alpine cat /sys/block/vda/queue/scheduler /sys/block/vda/queue/read_ahead_kb` 로 이 VM 의 스케줄러와 readahead 확인하기 (장치 이름은 `ls /sys/block` 로)
- [ ] 컨테이너에서 파일을 열어 둔 채 `rm` 하고 `df` 가 줄지 않는 것, `ls -l /proc/<pid>/fd` 에 `(deleted)` 로 보이는 것 확인하기
- [ ] 원자적 rename 패턴(fsync → rename → 디렉터리 fsync)을 Node 의 `fs` API 로 작성해 보기
- [ ] Redis 의 `appendfsync` 를 바꿔 가며 [DB 내부 실험](/db-internals/lab) 중 WAL vs AOF 결과와 이 노트의 fsync 표를 연결해 보기
