#!/usr/bin/env bash
#
# toss-trading 업데이트 배포 스크립트 (Lightsail 서버에서 실행)
#
#   git pull → pnpm install → (build:all) → pm2 restart → health check
#
# 빌드(WASM asc + vite)는 CPU 를 많이 써서 작은 버스트 인스턴스에선 CPU 크레딧을
# 소진시켜 throttle/먹통을 유발할 수 있다. 그래서 두 가지 경로를 지원한다:
#   - CI 자동 배포: 러너가 빌드한 dist 를 rsync 로 받은 뒤 SKIP_BUILD=1 로 호출 → 서버는 빌드 안 함.
#   - 서버에서 수동 실행: 그냥 ./update.sh → dist 가 없을 수 있으니 직접 build:all.
#
# 사용법:
#   최초 1회만)  cd ~/toss-trading && git pull && chmod +x update.sh
#   그 이후)     ./update.sh                 # 서버에서 직접 빌드(수동)
#                SKIP_BUILD=1 ./update.sh    # 이미 dist 가 준비된 경우 빌드 생략(CI 용)
#
set -euo pipefail

# 스크립트 위치(레포 루트)로 이동 — 어디서 실행해도 동작.
cd "$(dirname "$0")"

echo "▶ 1/4  git pull (origin/main)"
git pull --ff-only

echo "▶ 2/4  의존성 설치 (pnpm install)"
# 저우선순위로 실행 — 대용량 패키지(예: claude-agent-sdk 플랫폼 바이너리 ~250MB) 압축해제가
# 버스트 인스턴스 CPU/IO 를 독점하면 tailscaled·sshd 가 굶어 SSH keepalive 가 끊긴다.
NICE="nice -n 19"
command -v ionice >/dev/null 2>&1 && NICE="$NICE ionice -c 3"
$NICE pnpm install

if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "▶ 3/4  빌드 건너뜀 (SKIP_BUILD=1 — CI 에서 빌드된 dist 사용)"
else
  echo "▶ 3/4  빌드 (wasm + 프론트 dist)"
  # 프론트/wasm 변경 반영. 서버(server/*.ts)만 바뀌어도 무해.
  pnpm run build:all
fi

echo "▶ 4/4  pm2 재시작"
pm2 restart toss-trading --update-env || pm2 start pnpm --name toss-trading -- start
pm2 save >/dev/null 2>&1 || true

echo "▶ 헬스체크 대기..."
for _ in $(seq 1 15); do
  if curl -sf http://localhost:3001/api/health >/dev/null; then
    echo "✅ 배포 완료 — /api/health OK"
    pm2 logs toss-trading --lines 6 --nostream || true
    exit 0
  fi
  sleep 1
done

echo "⚠️  헬스체크 실패 — 아래 로그 확인 필요"
pm2 logs toss-trading --lines 20 --nostream || true
exit 1
