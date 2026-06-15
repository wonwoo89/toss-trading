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
3. 플랫폼/블루프린트: **Linux/Unix → OS Only → Ubuntu 22.04 LTS**
4. 플랜: **$5/월 (1GB RAM, 2 vCPU)** 면 충분
5. 인스턴스 이름 지정 후 **Create**
6. 생성되면 **Networking → Static IP → Create static IP** 로 고정 IP를 발급·연결
   - 이 고정 IP가 **토스에 등록할 아웃바운드 IP**다.
7. 방화벽(Networking → IPv4 Firewall): **SSH(22)만** 열어둔다. (HTTP/HTTPS 공개 불필요 — Tailscale로만 접속)

---

## 2. 접속 & 기본 패키지

```bash
# 로컬에서: Lightsail 콘솔에서 받은 키로 접속 (또는 콘솔 브라우저 SSH)
ssh -i LightsailDefaultKey.pem ubuntu@<고정IP>

# 서버에서: Node 22 + pnpm + git
sudo apt update
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
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

코드 변경을 반영할 때:

```bash
cd ~/toss-trading
git pull
pnpm install          # 의존성 변경 시
pnpm run build:all    # 프론트/WASM 변경 시
pm2 restart toss-trading --update-env
```

---

## 보안 체크리스트

- [ ] Lightsail 방화벽: **공개로 80/443/3001 열지 않음** (SSH 22만, 가능하면 내 IP로 제한)
- [ ] 앱 접속은 **Tailscale로만** → 사실상 나만 접근 가능 (주문 API 보호)
- [ ] `.env` 는 `chmod 600`, git에 커밋 금지
- [ ] 토스 키 노출 의심 시 WTS에서 즉시 재발급
- [ ] HTTPS는 Tailscale가 자동 — 평문 접속 없음

> 참고: 인증을 앱 레벨(로그인)로 추가하지 않은 이유는 **공개 노출 자체가 없기 때문**이다. 나중에 공개 도메인으로 열고 싶어지면, 그때 로그인/세션을 추가하면 된다.
