# Gargantua

기록하며 읽는 개인 서재 — EPUB · PDF · DOCX · Markdown · TXT.

## 배포(Cloudflare)

주소: https://gargantua.door9labs.workers.dev (Cloudflare Access로 잠금). 저장소 파일을 그대로 올린다(`wrangler.jsonc`, 뺄 것은 `.assetsignore`).

### 클라우드 세션에서 바로

1. 한 번만: Cloudflare에서 API 토큰 만들기 — My Profile → API Tokens → Create Token → **Edit Cloudflare Workers** 템플릿 → 계정 선택 → 만들기
2. 한 번만: claude.ai/code의 클라우드 환경 설정(세션 제목 옆 ▾ → Edit cloud environment) → **Environment variables**에
   `CLOUDFLARE_API_TOKEN=<토큰>` (계정이 여럿이면 `CLOUDFLARE_ACCOUNT_ID=<계정 ID>`도). 새 세션부터 적용
   - Network secrets에는 넣지 않는다: wrangler는 파일을 올릴 때 같은 `Authorization` 머리글에 Cloudflare가 준 일회용 키를 실어 보내서, 프록시가 붙이는 토큰과 겹친다
3. 배포: 고친 것을 main에 합친 뒤 `bash tools/deploy.sh`
   - 앱 파일(`sw.js`의 SHELL)이 바뀌었으면 판 번호(`js/main.js` BUILD = `sw.js` VERSION)를 고치고 멈춘다 → 커밋·push 뒤 다시 실행
   - 새 앱 파일을 SHELL에 안 넣었으면 멈춘다
   - `bash tools/deploy.sh --dry-run`: 토큰 없이 올릴 파일만 확인

휴대폰은 앱을 열어 두었다가 홈으로 나갔다 들어오면 새 판이 적용된다(설정 화면의 '웹 앱 … (판 번호)'로 확인).
