# Loopclaim.io 온라인 서버

게임 화면(`public/index.html`)과 실시간 게임 서버(`server.js`)가 한 프로그램에 같이 들어 있어요.
설치할 패키지가 하나도 없어서 Node.js만 있으면 바로 돌아가요.

```
online/
├── server.js          ← 게임 서버 (방 관리, 게임 계산, AI, 웹소켓)
├── public/index.html  ← 게임 화면 (서버가 그대로 보여줌)
├── package.json
└── build.sh           ← ttang.html이 바뀌면 public/index.html을 다시 만드는 스크립트
```

## 1. 내 컴퓨터에서 먼저 해보기

1. Node.js 18 이상을 설치해요 (https://nodejs.org).
2. 이 폴더에서 터미널을 열고:
   ```
   node server.js
   ```
3. 브라우저에서 http://localhost:8080 을 열고 **일반** 모드로 시작하기. (서버로 열면 일반 모드가 자동으로 온라인이 돼요. 서버에 연결이 안 되면 AI와 오프라인으로 시작해요.)
4. 창을 하나 더 열어서 들어가면 두 사람이 같은 맵에서 만나요.

## 2. 인터넷에 올리기 (Render 무료 플랜 예시)

1. 이 `online` 폴더를 GitHub 저장소에 올려요.
2. https://render.com 가입 → **New → Web Service** → 그 저장소 선택.
3. 설정:
   - Runtime: **Node**
   - Build Command: (비워두기)
   - Start Command: `node server.js`
4. 만들기를 누르면 `https://내이름.onrender.com` 같은 주소가 생겨요. 그 주소가 곧 게임 주소예요.
   - 무료 플랜은 15분 동안 아무도 없으면 잠들고, 다음 접속 때 30초쯤 걸려 깨어나요.

Fly.io, Railway, 일반 VPS도 똑같이 `node server.js`만 실행하면 돼요. 포트는 `PORT` 환경변수를 따라가요.

## 3. 게임 화면을 다른 곳(itch.io 등)에 올릴 때

화면만 따로 올리면 서버 주소를 알려줘야 해요. 주소 뒤에 붙이면 돼요:

```
https://내게임.itch.io/loopclaim?server=wss://내이름.onrender.com/ws
```

## 4. 게임을 고친 뒤

`src/ttang.html`을 고쳤으면 `sh build.sh`로 `public/index.html`을 다시 만들고 서버에 올려요.

## 동작 방식

- 온라인 모드: 일반 · 팀전(2/4팀) · 생존전 · 감염 · 3분 승부 · 랭크전 (기본/대형 맵). 사람이 적으면 AI로 채우고, 방이 차면 새 방이 열려요.
- 판이 끝나는 모드(3분 승부·랭크전·팀전·생존전·감염)는 결과를 보여준 뒤 9초 후 자동으로 다음 판이 시작돼요.
- 서버가 모든 걸 계산하고(움직임·자르기·땅 먹기), 플레이어는 방향키만 보내요. 그래서 조작으로 치트를 쓸 수 없어요.
- 맵 100×100, 0.115초마다 한 칸.
- 코인·스킨·업적은 각자 브라우저에 저장돼요. 온라인 랭킹(Claude 페이지 전용)은 여기선 꺼져 있어요.

## 지역 서버 (Fly.io)

한 앱을 여러 지역에 띄우면, 접속한 사람이 자동으로 가장 가까운 서버로 가요. 메뉴의 "서버" 칸에서 직접 고를 수도 있어요.

지역: 북아메리카(iad) · 남아메리카(gru) · 유럽(fra) · 아시아/일본(nrt) · 동남아/싱가포르(sin) · 오세아니아/호주(syd) · 아프리카/남아공(jnb)
(Fly.io에는 한국 서버가 없어요. 한국에서는 일본(nrt)이 가장 가까워요. 한국 서버를 따로 두면 `KR_URL` 환경변수에 `wss://주소/ws`를 넣어요.)

1. https://fly.io 가입 (카드 등록 필요)
2. 컴퓨터에 flyctl 설치 후, 이 폴더에서:
   ```
   fly launch --no-deploy --copy-config --name loopclaim
   fly deploy
   fly scale count 1 --region iad,gru,fra,nrt,sin,syd,jnb
   ```
3. (자동 배포) `fly tokens create deploy` 로 토큰을 만들어 GitHub 저장소 Settings → Secrets → Actions 에 `FLY_API_TOKEN` 으로 넣으면, main에 push할 때마다 자동 배포돼요.

사람이 없는 지역 서버는 자동으로 잠들고(요금 거의 없음), 누가 접속하면 1~2초 만에 깨어나요.
