#!/usr/bin/env bash
# Cloudflare 배포 — 클라우드 세션(또는 아무 컴퓨터)에서: 판 번호 확인 → 올리기
#   bash tools/deploy.sh            올리기
#   bash tools/deploy.sh --dry-run  올릴 파일만 확인(토큰 없이도 됨)
# 필요한 것: 환경 변수 CLOUDFLARE_API_TOKEN(Workers 수정 권한), 계정이 여럿이면 CLOUDFLARE_ACCOUNT_ID
# 판 번호(js/main.js BUILD = sw.js VERSION)는 앱 파일(sw.js SHELL) 내용으로 정한다 — 내용이 바뀌었는데 번호가
# 그대로면 휴대폰의 앱이 새 판을 받지 않는다. 번호를 고쳐야 하면 고쳐 두고 멈춘다(커밋·push 뒤 다시 실행).
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
for a in "$@"; do [ "$a" = "--dry-run" ] && DRY=1; done

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "커밋하지 않은 변경이 있습니다 — 올리는 내용과 저장소가 같도록 먼저 커밋하세요." >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

python3 - <<'PY'
import hashlib, pathlib, re, sys
root = pathlib.Path('.')
sw = (root / 'sw.js').read_text(encoding='utf-8')
shell = re.findall(r"'([^']+)'", re.search(r"const SHELL = \[(.*?)\];", sw, re.S).group(1))
files = [f for f in shell if f != './']
missing = [f for f in files if not (root / f).is_file()]
if missing:
    sys.exit('sw.js SHELL에 있는데 없는 파일: ' + ', '.join(missing))
# 앱 화면 부품은 모두 SHELL에 있어야 오프라인에서도 열린다(빠지면 새 판에서 그 기능이 안 뜬다)
app = sorted(str(p) for d in ('js', 'css') for p in (root / d).rglob('*') if p.is_file() and p.suffix in ('.js', '.mjs', '.css'))
app += [p.name for p in root.glob('*.html')] + [p.name for p in root.glob('*.webmanifest')]
unlisted = [f for f in app if f not in shell]
if unlisted:
    sys.exit('sw.js SHELL에 빠진 앱 파일: ' + ', '.join(unlisted))
h = hashlib.sha256()
for f in files + ['sw.js']:
    t = (root / f).read_bytes()
    t = re.sub(rb"const VERSION = '[0-9a-f]+';", b"const VERSION = '';", t)
    t = re.sub(rb"export const BUILD = '[0-9a-f]+';", b"export const BUILD = '';", t)
    h.update(f.encode() + b'\0' + t)
want = h.hexdigest()[:10]
changed = False
for path, pat, new in (('sw.js', r"const VERSION = '([0-9a-f]+)';", f"const VERSION = '{want}';"),
                       ('js/main.js', r"export const BUILD = '([0-9a-f]+)';", f"export const BUILD = '{want}';")):
    p = root / path
    s = p.read_text(encoding='utf-8')
    m = re.search(pat, s)
    if not m:
        sys.exit(f'{path}에서 판 번호를 찾지 못했습니다')
    if m.group(1) != want:
        p.write_text(s[:m.start()] + new + s[m.end():], encoding='utf-8')
        changed = True
if changed:
    print(f'판 번호를 {want}(으)로 고쳤습니다 — js/main.js·sw.js를 커밋·push한 뒤 다시 실행하세요.')
    sys.exit(3)
print(f'판 번호 {want} · 앱 파일 {len(files)}개 확인')
PY

echo "올릴 커밋: $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD)) $(git log -1 --format=%s)"
if [ "$DRY" = 0 ] && [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN이 없습니다 — 클라우드 환경 설정의 환경 변수에 넣은 뒤 새 세션에서 실행하세요(README '배포')." >&2
  exit 2
fi
export WRANGLER_SEND_METRICS=false
exec npx --yes wrangler@4 deploy "$@"
