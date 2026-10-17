// 로딩 화면 — 켤 때, 그리고 1분 넘게 가려져 있다 돌아올 때 Dropbox에서 다른 기기의 변경을 받아 화면이 최신이 될 때까지 덮는다.
// 받기 전에 옛 자리로 문서를 열면 다른 기기에서 더 읽은 자리를 덮고, 옛 메모를 고치면 충돌본이 생긴다
// (메모앱 판 172·DeskFlow 0.9.110과 같은 까닭). 그동안은 누르기·치기를 막는다.
// 오프라인이면 그렇다고 알리고 바로 열고, 8초 넘게 걸리면 '이 기기 자료로 열기' —
// 그때는 받기가 끝날 때까지 읽던 자리 쓰기만 미룬다(reader/index.js)
import { on, sleep } from '../util.js';
import { whenFresh, isStale, syncStatus } from '../sync/sync.js';

const AWAY_MS = 60000; // 이만큼 넘게 가려져 있다 돌아오면 덮는다
const SKIP_MS = 8000; // 이만큼 걸리면 '이 기기 자료로 열기'
const VEIL_MS = 300; // 돌아올 때는 이만큼 지나도 안 끝났을 때만 보인다(최신이면 번쩍이지 않게 — 누르기는 처음부터 막는다)

let gateOn = false;
let run = 0;
let pct = 0;
let goal = 0;
let final = false; // 마지막 안내(오프라인·연결 못 함·최신)를 띄웠다 — 함께 도는 받기의 단계 글귀가 덮어쓰지 않게
let paintTimer = null;

const box = () => document.getElementById('boot');
export const gateActive = () => gateOn;

function stage(msg, g, isFinal = false) {
  if (!gateOn || (final && !isFinal)) return;
  if (isFinal) final = true;
  box().querySelector('.boot-msg').textContent = msg;
  goal = Math.max(goal, g);
}

// 목표까지 남은 거리의 일부씩 가고, 목표에 닿은 뒤에도 끝(96%)을 향해 아주 조금씩 — 한 단계가 오래 걸려도 멈춰 보이지 않게
function paint() {
  if (pct < goal) pct += Math.max((goal - pct) * 0.18, 0.4);
  else if (pct < 96) pct += (96 - pct) * 0.006;
  box().querySelector('.boot-fill').style.width = `${Math.min(pct, 100).toFixed(1)}%`;
}

on('sync-stage', ({ stage: s }) => {
  if (s === 'check') stage('바뀐 내용 확인 중…', 50);
  else if (s === 'download') stage('바뀐 기록 받는 중…', 72);
  else if (s === 'apply') stage('맞추는 중…', 88);
});

// 덮는 동안은 키를 앱에 넘기지 않는다(새로고침·창 닫기·Tab과 '이 기기 자료로 열기' 단추는 그대로)
addEventListener('keydown', (e) => {
  if (!gateOn || e.target?.classList?.contains('boot-skip')) return;
  const k = (e.key || '').toLowerCase();
  if (e.key === 'F5' || e.key === 'Tab' || ((e.ctrlKey || e.metaKey) && (k === 'r' || k === 'w'))) return;
  e.stopImmediatePropagation();
  e.preventDefault();
}, true);

// 받기가 끝날 때까지 덮는다. 끝나면 결과('done'·'offline'·'fail'·'skip')를 돌려주고, 걷는 것은 closeGate()가 한다.
// 덮을 일이 없으면(Dropbox 연결 없음·이미 최신·이미 덮는 중) null
// kind: 'start' = 켤 때(시작 화면 위에 게이지) / 'resume' = 돌아올 때(처음 잠깐은 투명하게 덮는다)
export async function runGate(kind) {
  const el = box();
  if (gateOn || !el || !isStale()) return null;
  const my = ++run;
  gateOn = true;
  pct = 0;
  goal = 0;
  final = false;
  const veil = kind === 'resume';
  const skip = el.querySelector('.boot-skip');
  el.hidden = false;
  el.classList.remove('done');
  el.classList.toggle('veil', veil);
  el.querySelector('.boot-gate').hidden = false;
  el.querySelector('.boot-fill').style.width = '0%';
  skip.hidden = true;
  // 고치던 칸에서 손을 뗀다(휴대폰 자판도 내려간다) — 받기가 끝나면 최신 내용에서 다시
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  clearInterval(paintTimer);
  paintTimer = setInterval(paint, 80);
  stage('Dropbox 연결 중…', 25);
  const unveil = () => el.classList.remove('veil');
  const veilTimer = veil ? setTimeout(unveil, VEIL_MS) : null;
  let skipTimer = null;
  const skipped = new Promise((res) => {
    skipTimer = setTimeout(() => {
      unveil();
      skip.hidden = false;
      skip.onclick = () => res('skip');
    }, SKIP_MS);
  });
  const outcome = !navigator.onLine ? 'offline'
    : await Promise.race([whenFresh().then((ok) => (ok ? 'done' : navigator.onLine ? 'fail' : 'offline')), skipped]);
  clearTimeout(veilTimer);
  clearTimeout(skipTimer);
  if (my !== run) return outcome;
  if (outcome === 'offline' || outcome === 'fail') {
    unveil();
    const why = outcome === 'offline' ? '오프라인' : /다시 연결/.test(syncStatus().label) ? 'Dropbox 다시 연결이 필요합니다' : '연결하지 못했습니다';
    stage(`${why} · 이 기기 자료로 엽니다`, 100, true);
    pct = 100;
    paint();
    await sleep(outcome === 'offline' ? 900 : 1400);
  } else if (outcome === 'done') {
    // 다 찬 게이지는 걷히며 흐려지는 동안 보인다
    stage('최신 상태입니다', 100, true);
    pct = 100;
    paint();
  }
  return outcome;
}

// 시작 화면·로딩 화면을 걷는다(켤 때 Dropbox 연결이 없어 덮지 않았어도 시작 화면은 여기서 걷는다)
export function closeGate() {
  gateOn = false;
  clearInterval(paintTimer);
  paintTimer = null;
  const el = box();
  if (!el) return;
  if (el.classList.contains('veil')) { // 보이기 전에 끝났다 — 그냥 걷는다
    el.classList.remove('veil');
    el.classList.add('done');
    el.hidden = true;
    return;
  }
  el.classList.add('done');
  const my = run;
  setTimeout(() => { if (!gateOn && my === run) el.hidden = true; }, 320);
}

// 1분 넘게 가려져 있다 돌아오면 받기가 끝날 때까지 덮는다. onFresh: 걷기 전에 화면을 받은 것으로 다시 그린다
export async function resumeGate(away, onFresh) {
  if (away <= (globalThis.__gTest?.awayMs ?? AWAY_MS) || gateOn) return;
  const outcome = await runGate('resume');
  if (!outcome) return;
  if (outcome === 'done') onFresh?.();
  closeGate();
}
