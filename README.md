# toss-trading

토스증권 Open API 기반의 미국 주식 트레이딩 WTS(Web Trading System). 실시간 시세·호가·체결, 차트, 주문(지정가/시장가), 보유/주문 포트폴리오, 그리고 매수/매도 **추천 계산**(지정가·수량·익절률)과 차트 신호를 제공한다.

## 기술 스택

- **프론트엔드**: React 19 + TypeScript + Vite 8, React Router
- **BFF 서버**: Express 5 (토스 Open API 프록시 + OAuth 토큰 관리)
- **지표 커널**: AssemblyScript → WASM (볼린저 밴드 · ATR), 메인 스레드 분리를 위해 **Web Worker**에서 실행
- **패키지 매니저**: pnpm

## 아키텍처

```
client/                 # 프론트엔드 (Feature-Sliced Design)
  app/                  # 앱 진입점·프로바이더(컨텍스트)·전역 스타일
  pages/                # 라우트 페이지 (예: 거래 화면)
  widgets/              # 화면 단위 컴포넌트 (MarketPanel, OrderForm, PortfolioSidebar …)
  features/             # 도메인 로직 (trade: 폴링·주문·스냅샷 캡슐화)
  entities/             # 도메인 모델 (position 등)
  shared/               # 공용 (api 클라이언트, hooks, lib, workers, types)
    workers/            # 추천/지표 계산 Web Worker + 클라이언트
    lib/wasm/           # 컴파일된 indicators.wasm + 래퍼
server/                 # Express BFF
  routes/               # account · market · orders
  lib/                  # toss-client(OAuth/요청), stock-search, candle-aggregate …
  scripts/              # auth 점검 등
wasm/                   # AssemblyScript 지표 커널 소스 + 회귀 테스트
```

### 데이터 흐름
브라우저 → Vite dev 프록시(`/api`) → Express BFF(`:3001`) → 토스 Open API.
BFF는 OAuth 토큰을 캐시·갱신하고 클라이언트엔 자격증명을 노출하지 않는다.

### 계산 오프로딩
추천/지표 계산은 메인 스레드를 막지 않도록 Web Worker로 위임한다. 워커 안에서는 WASM 지표 백엔드를 등록해 핫 루프(볼린저·ATR)를 가속하고, WASM 준비 전이나 미지원 환경에서는 동일 수식의 JS 구현으로 폴백한다.

## 사전 준비

- Node.js 22+
- pnpm
- 토스증권 Open API 자격증명 (토스 앱 → WTS → 설정 → Open API에서 발급)
  - ⚠️ Open API는 **호출 IP 허용목록(allowlist)** 을 요구한다. 등록은 WTS 설정에서 수동으로 하며, API로는 제공되지 않는다. VPN/프록시(예: Zscaler)를 쓰면 출구 IP가 바뀔 수 있으니 주의.

## 환경 변수

루트에 `.env`를 만든다 (`.env.example` 참고):

```
TOSS_CLIENT_ID=        # 토스 Open API client id
TOSS_CLIENT_SECRET=    # 토스 Open API client secret
TOSS_ACCOUNT_SEQ=      # 기본 계좌 seq (GET /api/v1/accounts 로 확인) — 보유/주문 API에 필요
PORT=3001              # Express BFF 포트 (Vite 프록시 타깃은 .env 의 PORT 를 따른다)
```

## 설치 & 실행

```bash
pnpm install

# WASM 지표 커널 빌드 (지표 변경 시 1회)
pnpm run build:wasm

# 개발 서버 (BFF + Vite 동시 실행)
pnpm run dev
```

- 클라이언트: http://localhost:5173
- BFF: http://localhost:3001 (헬스 체크: `GET /api/health`)

## 스크립트

| 명령 | 설명 |
| --- | --- |
| `pnpm run dev` | BFF(`tsx watch`) + Vite dev 서버 동시 실행 |
| `pnpm run dev:client` / `dev:server` | 각각 단독 실행 |
| `pnpm run build` | 타입체크(`tsc -b`) 후 프로덕션 빌드 |
| `pnpm run build:wasm` | AssemblyScript 지표 커널 → `indicators.wasm` 컴파일 |
| `pnpm run lint` | ESLint |
| `pnpm run format` | Prettier 포맷 |
| `pnpm run preview` | 빌드 결과 미리보기 |
| `pnpm run auth:test` | 토스 OAuth 토큰 발급 점검 |

WASM 커널 회귀 테스트(WASM↔JS 결과 일치)는 다음으로 실행한다:

```bash
node wasm/test/indicators.test.mjs
```

## CI

`.github/workflows/ci.yml`에서 푸시/PR마다 다음을 검증한다.
- WASM 커널 빌드 + 회귀 테스트
- ESLint
- 타입체크 & 빌드

## 트러블슈팅

- **`Token issuance failed (403): access_denied - IP address not allowed`**: 현재 출구 IP가 토스 Open API 허용목록에 없음. WTS 설정에서 현재 공인 IP를 등록한다. VPN/프록시 환경이면 출구 IP가 로테이션될 수 있어, 가능하면 회사 고정 IP를 등록하거나 토스 API 도메인을 프록시 예외 처리한다.
- **BFF 404 / 시세가 안 옴**: `:3001`을 다른 프로세스가 점유 중일 수 있다. `.env`의 `PORT`를 바꾸면 Vite 프록시 타깃도 따라간다.
- **`TOSS_ACCOUNT_SEQ` 미설정**: 보유/주문 관련 API가 동작하지 않는다. `GET /api/v1/accounts` 응답의 seq로 채운다.
