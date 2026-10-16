# Docker 실험실용 작은 이미지. 레이어·캐시·whiteout 을 관찰한다.
# (Dockerfile 은 줄 끝 주석을 지원하지 않으므로 주석은 별도 줄에)
FROM alpine:3.20

# 레이어 1: 패키지 (~4MB)
RUN apk add --no-cache curl

# 레이어 2: 파일 하나. 내용이 바뀌면 이 아래 캐시가 전부 무효화된다
COPY payload.txt /payload.txt

# 레이어 3: 5MB 를 만들고 같은 RUN 에서 지움 → 레이어 크기 거의 0
RUN dd if=/dev/zero of=/tmp/a bs=1M count=5 2>/dev/null && rm /tmp/a

# 레이어 4: 5MB 를 만들기만 함 → 5MB 가 레이어에 남는다
RUN dd if=/dev/zero of=/tmp/b bs=1M count=5 2>/dev/null

# 레이어 5: 다음 RUN 에서 지워도 레이어 4 의 5MB 는 그대로 (whiteout 파일만 기록)
RUN rm /tmp/b

CMD ["sh", "-c", "echo hello from lab && cat /payload.txt"]
