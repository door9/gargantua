// 설정: Dropbox 자동 동기화, 백업, 안드로이드 서재 옮기기, 화면, 저장 공간, 앱 정보
import { h, esc, fmtDateTime, fmtBytes, fmtRelative, toast, downloadBlob, pickFiles, copyText } from '../util.js';
import { ico } from '../icons.js';
import { state, setApp, liveDocs, localFileHashes } from '../store.js';
import { sheet, confirmDialog, infoButton, menu } from '../ui/overlay.js';
import { navigate, requestPersist, APP_VERSION, BUILD } from '../main.js';
import * as dbx from '../sync/dropbox.js';
import { syncNow, syncStatus, onSyncStatus, disconnectDropbox, downloadAll, lastSync } from '../sync/sync.js';
import { exportBackup, importBackupBlob, androidRemoteInfo, importAndroidFromDropbox } from '../sync/backup.js';

let root = null;
let off = null;

export async function render(container) {
  root = container;
  container.append(h('header', { class: 'vhead' }, h('h1', null, '설정')), h('div', { class: 'vbody' }));
  await fill();
  off?.();
  off = onSyncStatus(() => paintSync());
}

export function destroy() { off?.(); off = null; root = null; }
export function refresh() { if (root) paintSync(); }

function row(title, sub, ...acts) {
  return h('div', { class: 'set-row' }, h('div', { class: 'l' }, h('b', null, title), sub ? (sub instanceof Node ? sub : h('small', null, sub)) : null), acts.length ? h('div', { class: 'acts' }, ...acts) : null);
}
function section(title, info, ...rows) {
  return h('section', { class: 'set-sec' }, h('h2', null, title, info ? infoButton(info) : null), ...rows);
}

let syncBox = null;

async function fill() {
  const body = root.querySelector('.vbody');
  body.textContent = '';
  syncBox = h('div');
  body.append(section('Dropbox 동기화', 'Dropbox에 연결하면 서재 기록(하이라이트·메모·책갈피·읽던 위치·독서 시간)이 자동으로 백업되고, PC·휴대폰 어디서 열어도 같은 서재가 됩니다. 원본 파일은 한 번만 올리고, 다른 기기에서는 처음 열 때 받아 옵니다. 날마다 기록 사본도 Dropbox <b>Apps/Gargantua Door 9 Labs/web/backups</b>에 따로 남깁니다.', syncBox));
  await paintSync();

  body.append(section('안드로이드 앱에서 옮겨 오기', '안드로이드 Gargantua 앱의 서재(문서·하이라이트·메모·책갈피·읽던 위치)를 그대로 가져옵니다. 여러 번 가져와도 겹치지 않습니다. 원본 안드로이드 앱의 자료는 건드리지 않습니다.',
    row('안드로이드 서재 가져오기', 'Dropbox 백업 또는 백업 파일에서', h('button', { class: 'gbtn small', onclick: () => showAndroidImport() }, '가져오기'))));

  body.append(section('백업 파일', '서재 전체(원본 파일 포함)를 zip 파일 하나로 저장하거나, 그 파일에서 되살립니다. 되살릴 때는 지금 서재와 합쳐집니다(지우지 않음).',
    row('백업 파일 만들기', `문서 ${liveDocs().length}개와 모든 기록`, h('button', { class: 'gbtn small', onclick: () => doExport() }, '만들기')),
    row('백업 파일에서 가져오기', 'Gargantua 웹·안드로이드 백업 모두', h('button', { class: 'gbtn small', onclick: () => doImport() }, '파일 선택'))));

  const themeSeg = h('div', { class: 'seg' });
  for (const [k, label] of [['system', '시스템'], ['light', '밝게'], ['dark', '어둡게']]) {
    themeSeg.append(h('button', { class: `seg-btn${state.app.theme === k ? ' on' : ''}`, onclick: () => { setApp({ theme: k }); fill(); } }, label));
  }
  const autoSync = h('input', { type: 'checkbox', class: 'switch', 'aria-label': '자동 동기화' });
  autoSync.checked = state.app.autoSync !== false;
  autoSync.addEventListener('change', () => setApp({ autoSync: autoSync.checked }));
  body.append(section('화면·동작', null,
    row('앱 화면', '서재·노트 화면의 밝기(읽기 화면 색은 읽기 설정에서)', themeSeg),
    row('바꿀 때마다 자동 동기화', '끄면 앱을 열 때·나갈 때만', autoSync),
    row('하루 되새길 문장', `${state.app.reviewDaily || 10}개`, h('button', { class: 'gbtn small', onclick: (e) => menu(e.currentTarget, [5, 10, 20, 30, 50].map((n) => ({ label: `${n}개`, checked: (state.app.reviewDaily || 10) === n, onClick: () => { setApp({ reviewDaily: n }); fill(); } }))) }, '바꾸기'))));

  const storageRow = row('사용 중', '확인 중…');
  const persistRow = row('지우지 않게 보관', '확인 중…');
  body.append(section('저장 공간', '문서와 기록은 이 기기의 브라우저 저장소에 있습니다. 브라우저의 "사이트 데이터 삭제"를 하면 지워지므로 Dropbox 동기화를 켜 두세요. "지우지 않게 보관"이 켜져 있으면 저장 공간이 부족해도 브라우저가 임의로 지우지 않습니다.', storageRow, persistRow));
  paintStorage(storageRow, persistRow);

  body.append(section('도움말', null,
    row('키보드 단축키', 'PC에서 읽을 때', infoButtonWide(shortcutsHtml())),
    row('독서 기록', '읽은 시간·연속 일수', h('button', { class: 'gbtn small', onclick: () => navigate('#/stats') }, '보기'))));

  body.append(section('앱 정보', null,
    row('Gargantua', `웹 앱 ${APP_VERSION} (${BUILD}) · BEYOND THE EVENT HORIZON`),
    row('개인정보', '광고·추적 없음', infoButtonWide('<p>문서와 독서 기록은 이 기기 안에서만 처리됩니다. 개발자 서버는 없습니다.</p><p>Dropbox를 연결하면 문서 원본과 기록이 <b>본인의 Dropbox 앱 전용 폴더</b>(Apps/Gargantua Door 9 Labs)로만 전송됩니다. 연결 해제는 이 기기의 연결 정보만 지웁니다.</p><p>"찾아보기"를 누르면 고른 낱말이 해당 사전·검색 사이트로 전달됩니다.</p>')),
    row('사용한 공개 부품', 'pdf.js · fflate · DOMPurify · marked', infoButtonWide('<p>pdf.js (Apache-2.0), fflate (MIT), DOMPurify (Apache-2.0/MPL-2.0), marked (MIT). 사용 허가 문서는 앱 안 vendor/licenses 폴더에 함께 있습니다.</p>'))));
}

function infoButtonWide(html) {
  return infoButton(html);
}

function shortcutsHtml() {
  const rows = [
    ['← →', '전자책 보기에서 쪽 넘기기'], ['Space / PageDown', '한 화면 아래로'], ['Ctrl+F, /', '문서 안 찾기'], ['T', '목차'], ['B', '책갈피'], ['N', '하이라이트·메모 목록'],
    ['P', '줄글 ↔ 전자책 보기'], ['R', '무작위 장'], ['1–4', '선택한 글 색칠'], ['M', '선택한 글에 메모'], ['Esc', '닫기·서재로'],
  ];
  return `<div class="kbd-list">${rows.map(([k, v]) => `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`).join('')}</div>`;
}

async function paintStorage(storageRow, persistRow) {
  try {
    const est = await navigator.storage?.estimate?.();
    if (est) {
      const sub = h('small', null, `${fmtBytes(est.usage || 0)} / 쓸 수 있는 ${fmtBytes(est.quota || 0)}`);
      const bar = h('div', { class: 'storage-bar' }, h('i', { style: { width: `${Math.min(100, ((est.usage || 0) / Math.max(1, est.quota || 1)) * 100)}%` } }));
      storageRow.querySelector('.l').replaceChildren(h('b', null, '사용 중'), sub, bar);
    }
    const persisted = await navigator.storage?.persisted?.();
    persistRow.querySelector('.l small').textContent = persisted ? '켜짐 — 브라우저가 임의로 지우지 않습니다' : '꺼짐';
    if (!persisted) {
      persistRow.append(h('div', { class: 'acts' }, h('button', { class: 'gbtn small', onclick: async () => {
        await requestPersist();
        const ok = await navigator.storage?.persisted?.();
        toast(ok ? '지우지 않게 보관을 켰습니다.' : '브라우저가 허락하지 않았습니다. 홈 화면에 설치하면 대개 허락됩니다.');
        fill();
      } }, '요청')));
    }
  } catch { /* 지원 안 함 */ }
}

async function paintSync() {
  const box = syncBox;
  if (!box) return;
  const connected = await dbx.isConnected();
  box.textContent = '';
  if (!connected) {
    box.append(row('연결 안 됨', '연결하면 자동 백업·기기 간 동기화가 시작됩니다', h('button', { class: 'gbtn primary small', onclick: () => connectFlow() }, h('span', { html: ico('cloud') }), '연결')));
    return;
  }
  const acc = await dbx.accountInfo();
  const st = syncStatus();
  const dot = h('span', { class: `sync-dot ${st.state === 'busy' ? 'busy' : st.state === 'error' ? 'err' : 'ok'}` });
  const last = lastSync();
  const sub = h('small', null, dot, `${st.label}${last ? ` · 마지막 ${fmtRelative(last)}` : ''}`);
  box.append(row(acc?.name ? `${acc.name}` : 'Dropbox 연결됨', sub,
    h('button', { class: 'gbtn small', disabled: st.state === 'busy', onclick: () => syncNow({ reason: 'manual', force: true }) }, h('span', { html: ico('sync') }), '지금')));
  if (st.state === 'error' && st.error) {
    box.append(row('문제', st.error, /연결/.test(st.label) ? h('button', { class: 'gbtn small', onclick: () => connectFlow() }, '다시 연결') : null));
  }
  const local = await localFileHashes(true);
  const missing = liveDocs().filter((d) => !local.has(d.fileHash));
  if (missing.length) {
    box.append(row('원본이 아직 없는 문서', `${missing.length}개 — 열 때 받아 옵니다`, h('button', { class: 'gbtn small', onclick: (e) => fetchAll(e.currentTarget) }, h('span', { html: ico('download') }), '모두 받기')));
  }
  box.append(row('연결 해제', acc?.email || '', h('button', { class: 'gbtn small ghost', onclick: async () => {
    const ok = await confirmDialog({ title: 'Dropbox 연결을 끊을까요?', message: '<p>이 기기의 연결 정보만 지웁니다. Dropbox에 있는 백업과 이 기기의 서재는 그대로입니다.</p>', ok: '연결 해제' });
    if (!ok) return;
    await disconnectDropbox();
    paintSync();
  } }, '해제')));
}

async function fetchAll(btn) {
  btn.disabled = true;
  const n = await downloadAll((i, total, title) => { btn.textContent = `${i}/${total}`; void title; });
  toast(n ? `원본 ${n}개를 받았습니다.` : '받을 원본이 없습니다.');
  paintSync();
}

export function connectFlow() {
  return new Promise((resolve) => {
    const codeInput = h('input', { class: 'gfield', type: 'text', placeholder: '받은 코드를 붙여 넣기', autocomplete: 'off', spellcheck: 'false' });
    const msg = h('div', { class: 'gfield-hint' });
    let opened = false;
    const openBtn = h('button', { class: 'gbtn primary block', onclick: async () => {
      const { url, redirect } = await dbx.startAuth();
      if (redirect) { location.href = url; return; }
      window.open(url, '_blank', 'noopener');
      opened = true;
      msg.textContent = 'Dropbox 창에서 "허용"을 누른 뒤 나온 코드를 복사해 아래에 붙여 넣으세요.';
      setTimeout(() => codeInput.focus(), 300);
    } }, h('span', { html: ico('external') }), '1. Dropbox 열기');
    const pasteBtn = h('button', { class: 'gbtn small', onclick: async () => {
      try { codeInput.value = (await navigator.clipboard.readText()).trim(); } catch { toast('붙여넣기를 할 수 없습니다. 직접 붙여 넣어 주세요.'); }
    } }, '붙여넣기');
    const body = h('div', { class: 'code-steps' },
      h('ol', null,
        h('li', null, '아래 단추로 Dropbox를 열고 로그인한 뒤 ', h('b', null, '허용'), '을 누릅니다.'),
        h('li', null, '화면에 나온 ', h('b', null, '코드'), '를 복사합니다.'),
        h('li', null, '이 창으로 돌아와 코드를 붙여 넣고 ', h('b', null, '연결'), '을 누릅니다.')),
      openBtn,
      h('div', { style: 'display:flex;gap:8px' }, codeInput, pasteBtn),
      msg);
    let done = false;
    sheet({
      title: 'Dropbox 연결',
      body,
      className: 'gdialog',
      headerExtra: infoButton('안드로이드 Gargantua 앱과 같은 Dropbox 앱(Gargantua Door 9 Labs)을 쓰므로, 휴대폰 앱이 올린 백업도 여기서 바로 가져올 수 있습니다. 비밀번호는 Gargantua가 보지 않습니다.'),
      actions: [
        { label: '취소' },
        { label: '연결', primary: true, onClick: async () => {
          const code = codeInput.value.trim();
          if (!code) { msg.textContent = opened ? '코드를 붙여 넣어 주세요.' : '먼저 "Dropbox 열기"를 눌러 코드를 받아 주세요.'; return true; }
          msg.textContent = '연결 중…';
          try {
            const acc = await dbx.finishAuth(code);
            done = true;
            toast(`Dropbox에 연결했습니다${acc?.name ? ` (${acc.name})` : ''}. 동기화를 시작합니다.`);
            syncNow({ reason: 'connect', force: true });
            paintSync();
            offerAndroidAfterConnect();
            return false;
          } catch (e) {
            msg.textContent = e.message || String(e);
            return true;
          }
        } },
      ],
      onClose: () => resolve(done),
    });
  });
}

async function offerAndroidAfterConnect() {
  try {
    const meta = await androidRemoteInfo();
    if (!meta) return;
    if (liveDocs().some((d) => d.id.startsWith('a-'))) return;
    const ok = await confirmDialog({
      title: '안드로이드 앱의 서재를 가져올까요?',
      message: `<p>Dropbox에 안드로이드 Gargantua의 서재 백업이 있습니다.</p><p>${esc(fmtDateTime(Date.parse(meta.server_modified)))} · ${esc(fmtBytes(meta.size))}</p><p>문서와 하이라이트·메모·책갈피·읽던 위치를 그대로 가져옵니다.</p>`,
      ok: '가져오기',
    });
    if (ok) runAndroidImport('dropbox');
  } catch { /* 무시 */ }
}

export async function showAndroidImport() {
  const connected = await dbx.isConnected();
  let meta = null;
  if (connected) { try { meta = await androidRemoteInfo(); } catch { meta = null; } }
  const body = h('div', { class: 'code-steps' });
  let s;
  if (connected && meta) {
    body.append(h('div', { class: 'set-sec' }, row('Dropbox의 안드로이드 백업', `${fmtDateTime(Date.parse(meta.server_modified))} · ${fmtBytes(meta.size)}`, h('button', { class: 'gbtn primary small', onclick: () => { s.close(); runAndroidImport('dropbox'); } }, '가져오기'))));
  } else if (connected) {
    body.append(h('p', { class: 'gfield-hint' }, 'Dropbox에 안드로이드 백업이 아직 없습니다. 휴대폰의 안드로이드 Gargantua에서 ⋮ → "Dropbox 서재 백업" → "지금 백업"을 누른 뒤 다시 열어 주세요.'));
  } else {
    body.append(h('div', { class: 'set-sec' }, row('Dropbox로 가져오기', '안드로이드 앱이 Dropbox에 올린 백업', h('button', { class: 'gbtn small', onclick: async () => { s.close(); if (await connectFlow()) showAndroidImport(); } }, 'Dropbox 연결'))));
  }
  body.append(h('div', { class: 'set-sec' }, row('백업 파일로 가져오기', '안드로이드 앱의 "기기 백업 내보내기" 파일(.gargantua-backup)', h('button', { class: 'gbtn small', onclick: () => { s.close(); runAndroidImport('file'); } }, '파일 선택'))));
  s = sheet({ title: '안드로이드 서재 가져오기', body, className: 'gdialog' });
}

async function runAndroidImport(source) {
  let blob = null;
  if (source === 'file') {
    const files = await pickFiles({ accept: '.gargantua-backup,.zip,application/zip,application/octet-stream', multiple: false });
    if (!files.length) return;
    blob = files[0];
  }
  const status = h('div', { class: 'import-status' }, h('div', { class: 'spinner' }), h('span', null, '가져오는 중'));
  document.body.append(status);
  try {
    const onStatus = (m) => { status.lastChild.textContent = m; };
    const rep = source === 'dropbox' ? await importAndroidFromDropbox({ onStatus }) : await importBackupBlob(blob, { onStatus });
    status.remove();
    showReport(rep);
    requestPersist();
  } catch (e) {
    status.remove();
    toast(e.message || String(e), { duration: 7000 });
  }
}

function showReport(rep) {
  if (rep.kind === 'web') {
    toast(`백업에서 문서 ${rep.docs}개, 노트 ${rep.anns}개를 합쳤습니다.`, { duration: 5000 });
    return;
  }
  const lines = [
    `<p>문서 <b>${rep.docs}</b>개, 하이라이트 <b>${rep.highlights}</b>개, 메모 <b>${rep.notes}</b>개, 책갈피 <b>${rep.bookmarks}</b>개를 옮겼습니다.</p>`,
  ];
  if (rep.orphans) lines.push(`<p>${rep.orphans}개는 본문에서 정확한 자리를 찾지 못해 근처 위치로 두었습니다(노트 화면에서 그대로 볼 수 있습니다).</p>`);
  if (rep.skipped.length) lines.push(`<p>건너뜀: ${rep.skipped.map(esc).join('<br>')}</p>`);
  confirmDialog({ title: '안드로이드 서재를 옮겨 왔습니다', message: lines.join(''), ok: '서재 보기', cancel: '닫기' }).then((ok) => { if (ok) navigate('#/library'); });
}

async function doExport() {
  const status = h('div', { class: 'import-status' }, h('div', { class: 'spinner' }), h('span', null, '백업 만드는 중'));
  document.body.append(status);
  try {
    const { blob, docs, missing } = await exportBackup({ onStatus: (m) => { status.lastChild.textContent = m; } });
    const d = new Date();
    const name = `Gargantua-백업-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.zip`;
    downloadBlob(blob, name);
    toast(`백업 파일을 만들었습니다 (${docs}개, ${fmtBytes(blob.size)})${missing ? ` · 원본 없는 문서 ${missing}개는 기록만` : ''}`, { duration: 5000 });
  } catch (e) {
    toast(`백업을 만들지 못했습니다: ${e.message || e}`);
  } finally {
    status.remove();
  }
}

async function doImport() {
  const files = await pickFiles({ accept: '.zip,.gargantua-backup,application/zip,application/octet-stream', multiple: false });
  if (!files.length) return;
  const status = h('div', { class: 'import-status' }, h('div', { class: 'spinner' }), h('span', null, '가져오는 중'));
  document.body.append(status);
  try {
    const rep = await importBackupBlob(files[0], { onStatus: (m) => { status.lastChild.textContent = m; } });
    status.remove();
    showReport(rep);
  } catch (e) {
    status.remove();
    toast(e.message || String(e), { duration: 6000 });
  }
}

export { copyText };
