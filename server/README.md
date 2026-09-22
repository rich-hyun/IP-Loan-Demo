# 백엔드 API 배포 가이드 (연구실 서버)

프론트엔드가 더 이상 브라우저에만 데이터를 저장하지 않고, 이 API를 통해 서버의 SQLite
파일에 저장합니다. 즉 **누가 사이트에 들어와도 같은 데이터**를 보게 됩니다.

## 왜 도메인(HTTPS)이 필요한가요

프론트엔드는 GitHub Pages 등 **https://** 로 서비스됩니다. 브라우저는 https 페이지가
암호화되지 않은 http:// 주소로 요청을 보내는 것을 보안상 차단합니다("mixed content").
그래서 이 API도 **http://공인IP:포트** 가 아니라 **https://도메인** 으로 접속 가능해야
프론트엔드에서 정상적으로 호출할 수 있습니다. 이전에 논의한 가비아 도메인의 서브도메인
(예: `api.yourdomain.co.kr`)을 이 서버로 연결하는 걸 추천드립니다.

## 1. 서버에 올리기

```bash
# 로컬에서 서버로 복사 (예시)
scp -r server/ your-id@203.252.147.197:/opt/iploan-api
```

또는 git으로 관리한다면 서버에서 `git clone` 해도 됩니다.

## 2. 파이썬 환경 준비

```bash
cd /opt/iploan-api
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## 3. 먼저 로컬에서 동작 확인

```bash
python3 app.py
# 다른 터미널에서
curl http://127.0.0.1:5000/api/applications
```

8건의 신청 데이터가 JSON으로 나오면 정상입니다. 확인했으면 `Ctrl+C`로 종료하세요.

## 4. systemd로 등록 (재부팅해도 자동 실행)

`iploan-api.service` 파일에서 `REPLACE_WITH_YOUR_LINUX_USER`를 실제 계정명으로 바꾼 뒤:

```bash
sudo cp iploan-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now iploan-api
sudo systemctl status iploan-api   # active (running) 확인
```

## 5. 도메인 연결 + Nginx + HTTPS

1. 가비아 My가비아 → DNS 관리에서 서브도메인 A 레코드 추가: 호스트 `api`, 값 `203.252.147.197`
2. Nginx 설치가 안 되어 있다면: `sudo apt install nginx` (Ubuntu/Debian 기준)
3. `nginx-iploan-api.conf`에서 `server_name`을 실제 서브도메인으로 바꾼 뒤:
   ```bash
   sudo cp nginx-iploan-api.conf /etc/nginx/sites-available/iploan-api
   sudo ln -s /etc/nginx/sites-available/iploan-api /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```
4. HTTPS 인증서 발급 (Let's Encrypt, 무료):
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d api.yourdomain.co.kr
   ```
   certbot이 nginx 설정을 자동으로 443 포트용으로 갱신해줍니다.

## 6. 프론트엔드에 연결

`js/app.js` 맨 위쪽의 다음 줄을:

```js
const API_BASE = 'https://api.YOUR-DOMAIN.example/api';
```

실제 서브도메인으로 바꾸고 다시 배포하면 끝입니다.

```bash
curl https://api.yourdomain.co.kr/api/applications
```

이 명령으로 JSON이 정상적으로 나오는지 먼저 확인한 뒤 프론트엔드를 배포하세요.

## 알아두면 좋은 점

- 지금 API는 별도 인증 없이 열려 있습니다. 인터넷에 공개된 상태에서 누구나 신청을
  생성/수정할 수 있다는 뜻이라, 로그인 기능을 붙이기 전까지는 시연·내부 검토용으로만
  링크를 공유하는 걸 권장합니다.
- 데이터는 `/opt/iploan-api/iploan.db` 파일 하나에 SQLite로 저장됩니다. 백업하려면
  이 파일만 복사하면 됩니다.
- "데이터 초기화" 버튼은 이제 이 서버의 `/api/reset` 을 호출해서 **모든 방문자가 보는
  데이터**를 초기 상태로 되돌립니다 (개인 브라우저만 초기화되는 게 아님) — 주의해서 사용하세요.
