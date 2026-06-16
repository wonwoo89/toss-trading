# 배포 가이드 — AWS Lightsail + Tailscale

개인 전용으로 안전하게 배포하는 방법. **공개 인터넷에 노출하지 않고**, Tailscale 메시 VPN으로 내 기기(노트북·스마트폰)에서만 접속한다. HTTPS 인증서는 Tailscale이 자동 발급하므로 도메인 구매·인증서 설치가 필요 없다.

```
[내 폰/노트북 + Tailscale]  ──(암호화, 셀룰러/와이파이 무관)──►  [Lightsail VM]
                                                                  └ Express(:3001) = /api 프록시 + dist 정적 서빙
                                                                  └ 아웃바운드 → 토스 Open API (고정 IP)
```

핵심:
- **인바운드**(앱 접속): Tailscale로만. 앱 포트(3001)는 공개로 절대 열지 않는다.
- **아웃바운드**(토스 호출): Lightsail **고정 IP**로 나간다 → 이 IP를 토스 허용목록에 1번만 등록.

---

## 1. Lightsail 인스턴스 생성

1. AWS 콘솔 → **Lightsail** → **Create instance**
2. 리전: `Seoul (ap-northeast-2)` (지연 최소)
3. 플랫폼/블루프린트: **Linux/Unix → OS Only → 최신 Ubuntu LTS (24.04 권장, 22.04 도 가능)**
   - apt 계열(Ubuntu/Debian)이면 아래 명령을 그대로 사용. 핵심 요건은 "Node 24 설치 가능한 최신 LTS".
4. 플랜: **$7/월 (1GB RAM, 2 vCPU)** 권장
   - 네트워크 타입은 **Dual-stack**(공용 IPv4 포함)으로. *IPv6-only 금지* — 고정 IPv4 가 있어야 토스 허용목록 등록 + 아웃바운드가 그 IP로 나간다.
   - $5(512MB)는 런타임엔 충분하지만 **서버에서 `vite build` 시 메모리 부족(OOM)으로 빌드가 죽기 쉽다.** 굳이 $5로 가려면 스왑 2GB 추가 또는 로컬 빌드 후 `dist` 업로드로 우회.
5. 인스턴스 이름 지정 후 **Create**
6. 생성되면 **Networking → Static IP → Create static IP** 로 고정 IP를 발급·연결
   - 이 고정 IP가 **토스에 등록할 아웃바운드 IP**다.
7. 방화벽(Networking → IPv4 Firewall): **SSH(22)만** 열어둔다. (HTTP/HTTPS 공개 불필요 — Tailscale로만 접속)

---

## 2. 접속 & 기본 패키지

```bash
# 로컬에서: Lightsail 콘솔에서 받은 키로 접속 (또는 콘솔 브라우저 SSH)
ssh -i LightsailDefaultKey.pem ubuntu@<고정IP>

# 서버에서: Node 24 + pnpm + git
sudo apt update
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git
sudo corepack enable && corepack prepare pnpm@latest --activate
node -v && pnpm -v
```

---

## 3. 코드 가져오기

비공개 레포라 인증이 필요하다. 가장 간단한 방법은 **GitHub Personal Access Token(PAT)** 으로 HTTPS clone:

```bash
cd ~
git clone https://github.com/wonwoo89/toss-trading.git
# Username: GitHub 사용자명, Password: PAT(repo 읽기 권한) 입력
cd toss-trading
pnpm install
```

> 대안: 서버에 SSH 키를 만들어(`ssh-keygen`) 공개키를 GitHub에 **Deploy key**로 등록하면 토큰 없이 `git@github.com:...` clone 가능.

---

## 4. 환경 변수(.env) 전달

`.env`는 git에 없으므로 직접 만든다. 로컬에서 올리거나(서버 레포 루트로):

```bash
# 로컬에서
scp -i LightsailDefaultKey.pem .env ubuntu@<고정IP>:~/toss-trading/.env
```

또는 서버에서 직접 작성:

```bash
cd ~/toss-trading
nano .env   # 아래 내용 채우고 저장
chmod 600 .env
```

```
TOSS_CLIENT_ID=...
TOSS_CLIENT_SECRET=...
TOSS_ACCOUNT_SEQ=...
PORT=3001
```

---

## 5. 빌드

```bash
cd ~/toss-trading
pnpm run build:all   # = build:wasm + build (dist 생성)
```

---

## 6. 상시 실행 (pm2)

```bash
sudo npm install -g pm2

# 운영 모드로 실행 (start 스크립트가 NODE_ENV=production 로 dist 정적 서빙까지 수행)
pm2 start pnpm --name toss-trading -- start

pm2 save                 # 현재 프로세스 목록 저장
pm2 startup              # 부팅 시 자동 시작 — 출력되는 sudo 명령을 복사해 실행
pm2 logs toss-trading    # 로그 확인 (BFF 토큰 발급/시세 로그)
```

확인: `curl http://localhost:3001/api/health` → `ok` 또는 토큰 상태 JSON.

---

## 7. Tailscale 설치 & 비공개 HTTPS 노출

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up          # 출력된 URL을 브라우저로 열어 내 계정으로 로그인 → VM이 테일넷에 합류
tailscale ip -4            # 이 VM의 Tailscale IP(100.x.x.x) 확인
```

Tailscale 관리 콘솔(admin)에서 한 번만 활성화:
- **MagicDNS** 켜기
- **HTTPS Certificates** 켜기

그다음 앱을 테일넷 전용 HTTPS로 노출:

```bash
sudo tailscale serve --bg 3001
tailscale serve status     # https://<머신이름>.<테일넷>.ts.net 주소 확인
```

이제 `https://<머신이름>.<테일넷>.ts.net` 가 곧 접속 주소다. (공개 인터넷엔 안 뜸)

---

## 8. 스마트폰에서 접속 (셀룰러 포함)

1. 폰에 **Tailscale 앱** 설치 → **같은 계정**으로 로그인 (폰이 테일넷에 합류)
2. Tailscale 토글 **ON**
3. 폰 브라우저에서 `https://<머신이름>.<테일넷>.ts.net` 접속 — **셀룰러에서도 동작**
   - 직접 연결이 막히면 Tailscale이 자동으로 릴레이(443)로 폴백하므로 통신사망에서도 거의 항상 됨

---

## 9. 토스 IP 허용목록 등록 (필수)

토스 WTS → 설정 → Open API → **허용 IP**에 **Lightsail 고정 IP**(1번에서 발급한 그 IP)를 등록한다.
- 서버가 토스로 나가는 IP는 이 고정 IP이므로, **한 번만 등록하면 끝**(Zscaler처럼 바뀌지 않음).
- 등록 후 `pm2 logs toss-trading` 에서 `Toss OAuth token ready` 가 보이면 정상.

---

## 업데이트(재배포)

**스크립트 한 방** (권장) — `update.sh` 가 pull→install→build→restart→health 까지 자동:

```bash
# 최초 1회만: 스크립트를 받아온다
cd ~/toss-trading && git pull && chmod +x update.sh

# 그 이후 코드 업데이트마다
./update.sh
```

> 운영 모드는 빌드된 `dist` 를 정적 서빙하므로 **프론트/WASM 변경은 반드시 `build:all` 이 필요**하다(`pm2 restart` 만으로는 옛 화면 그대로). `server/*.ts` 만 바뀐 경우엔 `tsx` 가 직접 실행하므로 build 없이 restart 만으로도 반영되지만, `update.sh` 는 매번 build 해 헷갈릴 일이 없다.

수동으로 하려면:

```bash
cd ~/toss-trading
git pull
pnpm install          # 의존성 변경 시
pnpm run build:all    # 프론트/WASM 변경 시 (서버만 바뀌었으면 생략 가능)
pm2 restart toss-trading --update-env
```

---

## 자동 배포 (GitHub Actions + Tailscale SSH)

`main` 에 머지될 때마다 **CI(타입체크·ESLint·WASM 테스트)가 통과하면** GitHub Actions 가
테일넷에 임시로 합류해 서버에 SSH 로 들어가 `update.sh` 를 실행한다.
**공개 포트는 하나도 열지 않고**(러너는 GitHub 로 outbound 만 사용), **SSH 개인키도 두지 않는다**
(인증은 Tailscale SSH = 테일넷 신원으로 처리).

워크플로 파일: `.github/workflows/deploy.yml` (이미 레포에 있음).

```
[main 머지] → CI(ci.yml) 통과 → Deploy(deploy.yml)
   러너가 tag:ci 로 테일넷 합류 → ssh tag:ci → tag:prod(서버) → ./update.sh
```

### 1회성 셋업 — 서버

서버를 **태그 노드로 전환 + Tailscale SSH 활성화**한다. (기존 `tailscale serve` 설정·머신이름은 유지됨)

```bash
# 서버에서
sudo tailscale up --ssh --advertise-tags=tag:prod
tailscale status            # 머신이름(MagicDNS 호스트) 확인 — 아래 TS_SERVER_HOST 에 쓴다
```

> 태그가 ACL 에 정의돼 있어야 적용된다(아래 3번). 태그를 붙이면 노드가 tag-owned 로 바뀌지만
> serve(3001) 노출은 그대로 동작한다.

### 2회성 셋업 — Tailscale admin: OAuth client

러너가 테일넷에 합류할 자격증명을 만든다.

1. Tailscale admin → **Settings → OAuth clients → Generate OAuth client**
2. Scope: **Auth Keys → Write** (체크)
3. Tags: **`tag:ci`** 지정
4. 생성된 **Client ID / Client Secret** 을 아래 GitHub secret 으로 등록

### 3. Tailscale admin: ACL 정책

태그 정의 + "CI 러너(tag:ci) 가 서버(tag:prod) 에 `ubuntu` 로 SSH 가능" 규칙을 추가한다.

```jsonc
{
  "tagOwners": {
    "tag:ci":   ["autogroup:admin"],
    "tag:prod": ["autogroup:admin"]
  },

  // Tailscale SSH: CI 러너가 키 없이 서버에 ubuntu 로 로그인.
  // action 은 반드시 "accept" — "check" 는 대화형 재인증을 요구해 CI 에서 막힌다.
  "ssh": [
    {
      "action": "accept",
      "src":    ["tag:ci"],
      "dst":    ["tag:prod"],
      "users":  ["ubuntu", "autogroup:nonroot"]
    }
  ]
}
```

> 기본 ACL(`acls` 가 allow-all)이면 네트워크 도달성은 이미 열려 있다. `acls` 를 좁혀놨다면
> `tag:ci` → `tag:prod:22` 도 허용해야 한다.

### 4. GitHub repo 설정값

**Settings → Secrets and variables → Actions**

Secrets (Repository secrets):
| 이름 | 값 |
|------|----|
| `TS_OAUTH_CLIENT_ID` | 2번에서 만든 OAuth Client ID |
| `TS_OAUTH_SECRET` | 2번에서 만든 OAuth Client Secret |

Variables (Repository variables):
| 이름 | 값 |
|------|----|
| `TS_SSH_USER` | `ubuntu` (Lightsail Ubuntu 기본 사용자) |
| `TS_SERVER_HOST` | 1번 `tailscale status` 의 머신이름(MagicDNS 호스트). 예: `toss-trading` |

### 동작 확인

- 셋업 후 **Actions → Deploy (Lightsail) → Run workflow** 로 수동 1회 실행해 본다.
  로그에 `✅ 배포 완료 — /api/health OK` 가 보이면 정상.
- 이후엔 main 에 머지 → CI 통과 → 배포가 자동으로 돈다.
- 빌드 실패 시 `update.sh` 가 `pm2 restart` 전에 멈추므로 **기존 프로세스(구버전)는 계속 떠 있다** — 다운타임 없음.

---

## 보안 체크리스트

- [ ] Lightsail 방화벽: **공개로 80/443/3001 열지 않음** (SSH 22만, 가능하면 내 IP로 제한)
- [ ] 앱 접속은 **Tailscale로만** → 사실상 나만 접근 가능 (주문 API 보호)
- [ ] `.env` 는 `chmod 600`, git에 커밋 금지
- [ ] 토스 키 노출 의심 시 WTS에서 즉시 재발급
- [ ] HTTPS는 Tailscale가 자동 — 평문 접속 없음
- [ ] CD: OAuth client 는 **Auth Keys(write) scope + tag:ci** 로만 최소 권한. 노출 의심 시 admin 에서 즉시 폐기·재발급
- [ ] CD: ssh ACL 은 `tag:ci → tag:prod` 로만 한정 (CI 러너가 다른 노드엔 못 들어감)

> 참고: 인증을 앱 레벨(로그인)로 추가하지 않은 이유는 **공개 노출 자체가 없기 때문**이다. 나중에 공개 도메인으로 열고 싶어지면, 그때 로그인/세션을 추가하면 된다.
