#!/usr/bin/env bash
#
# toss-trading 업데이트 배포 스크립트 (Lightsail 서버에서 실행)
#
#   git pull → pnpm install → build:all → pm2 restart → health check
#
# 사용법:
#   최초 1회만)  cd ~/toss-trading && git pull && chmod +x update.sh
#   그 이후)     ./update.sh
#
set -euo pipefail

# 스크립트 위치(레포 루트)로 이동 — 어디서 실행해도 동작.
cd "$(dirname "$0")"

echo "▶ 1/4  git pull (origin/main)"
git pull --ff-only

echo "▶ 2/4  의존성 설치 (pnpm install)"
pnpm install

echo "▶ 3/4  빌드 (wasm + 프론트 dist)"
# 프론트/wasm 변경 반영. 서버(server/*.ts)만 바뀌어도 무해.
pnpm run build:all

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
