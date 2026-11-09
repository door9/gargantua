// 글자 인식 창: 글자 층이 없는 PDF 쪽을 읽어 전자책으로 다시 엮는다(⋮ 메뉴에서 시작한다).
// 쪽마다 보관하므로 멈추거나 앱을 닫아도 읽은 쪽은 남고, 다음에 이어 한다.
import { h, toast } from '../util.js';
import { sheet, infoButton } from '../ui/overlay.js';
import { requireFile, ocrDonePages, putOcrPage, loadBook } from '../docs.js';
import { openPdf, closePdf } from '../pdfdoc.js';
import { fetchRemoteFile, pushOcr } from '../sync/sync.js';

const INFO = `<b>글자 인식</b><br>글자가 그림으로 되어 있는 PDF를 이 기기 안에서 읽어 전자책처럼 다시 짭니다.<br><br>
· 틀린 글자가 있을 수 있습니다. 표는 원본 모양 그대로 넣습니다.<br>
· 한국어와 영어를 읽습니다.<br>
· 읽는 동안 화면을 켜 두세요. 멈춰도 읽은 쪽은 남아 이어 할 수 있습니다.<br>
· Dropbox가 연결되어 있으면 결과가 다른 기기로 넘어갑니다. 컴퓨터에서 읽으면 훨씬 빠릅니다.`;

function etaText(ms) {
  const min = Math.ceil(ms / 60000);
  if (min <= 1) return '1분 안에 끝납니다';
  if (min < 60) return `약 ${min}분 남음`;
  const hours = Math.floor(min / 60);
  return `약 ${hours}시간 ${min % 60 ? `${min % 60}분 ` : ''}남음`;
}

// 읽는 동안 화면이 꺼지지 않게(꺼지면 브라우저가 일을 멈춘다)
function keepScreenOn() {
  let lock = null;
  let on = true;
  const ask = async () => {
    try {
      if (on && document.visibilityState === 'visible') lock = await navigator.wakeLock?.request('screen');
    } catch { /* 안 되면 그만 */ }
  };
  document.addEventListener('visibilitychange', ask);
  ask();
  return () => {
    on = false;
    document.removeEventListener('visibilitychange', ask);
    lock?.release?.()?.catch?.(() => {});
  };
}

export async function startOcr(r) {
  const scan = r.bookRec?.book?.scan;
  if (r.ocrRunning || !scan) return;
  r.ocrRunning = true;
  const doc = r.doc;
  let job = null;
  let stopped = false;
  const count = h('span', { class: 'gocr-count' });
  const note = h('span', { class: 'gocr-note' }, '준비 중');
  const fill = h('i');
  const box = sheet({
    title: '글자 인식',
    headerExtra: infoButton(INFO),
    className: 'gdialog gocr-sheet',
    body: h('div', { class: 'gocr' }, h('div', { class: 'gocr-row' }, count, note), h('div', { class: 'gocr-bar' }, fill)),
    actions: [{ label: '멈추기' }],
    onClose: () => { stopped = true; job?.stop(); },
  });
  r.ocrStop = () => box.close();
  const releaseScreen = keepScreenOn();
  let own = null;
  let result = null;
  let failure = null;
  try {
    const have = await ocrDonePages(doc);
    const already = scan.pages.filter((p) => have.has(p)).length;
    const todo = scan.pages.filter((p) => !have.has(p));
    const total = scan.pages.length;
    const paint = (n) => {
      count.textContent = `${already + n} / ${total}쪽`;
      fill.style.width = `${((already + n) / total) * 100}%`;
    };
    paint(0);
    // 지금 보는 쪽부터 읽는다 — 앞쪽은 맨 뒤로
    const loc = r.view?.currentLoc();
    const here = (r.isPdf ? loc?.p ?? 0 : (loc && r.book?.pageStarts ? r.pageLocOf(loc).p : 0)) + 1;
    const pages = [...todo.filter((p) => p >= here), ...todo.filter((p) => p < here)];
    let pdf = r.isPdf ? r.pdf : null;
    if (!pdf) {
      const blob = await requireFile(doc, { fetchFile: fetchRemoteFile });
      own = await openPdf(blob);
      pdf = own;
    }
    if (stopped) return;
    const { OcrJob } = await import('../parse/ocrrun.js');
    let started = 0;
    job = new OcrJob({
      pdf,
      pages,
      judge: already === 0,
      onPage: (p, rec) => putOcrPage(doc, p, rec),
      onStage: (m) => { if (m) note.textContent = m; else { started = performance.now(); note.textContent = '읽는 중'; } },
      onProgress: ({ done }) => {
        paint(done);
        if (done >= 2 && done < pages.length) note.textContent = etaText(((performance.now() - started) / done) * (pages.length - done));
      },
    });
    if (stopped) return;
    result = await job.run();
  } catch (e) {
    console.error(e);
    failure = e;
  } finally {
    releaseScreen();
    if (own) closePdf(own);
    box.close();
    r.ocrRunning = false;
    r.ocrStop = null;
  }
  if (!r.alive) return;
  if (failure && !job?.done) {
    toast(/받지 못|fetch|network|import/i.test(failure.message || '') ? '글자 인식 부품을 받지 못했습니다. 인터넷 연결을 확인해 주세요.' : '글자 인식을 하지 못했습니다.');
    return;
  }
  if (!result?.done && !job?.done) return;
  r.setLoading('전자책으로 정리하는 중');
  try {
    const rec = await loadBook(doc, { force: true, onStatus: (m) => r.setLoading(m), fetchFile: fetchRemoteFile });
    const s = rec.book.scan;
    const complete = s.done >= s.pages.length;
    const hasBook = rec.book.reflow !== false;
    await r.adoptBook(rec, { open: complete && hasBook });
    r.setLoading(null);
    if (result?.unreadable || (complete && !hasBook)) toast('글자를 알아보지 못했습니다. 한국어와 영어 문서만 읽을 수 있습니다.', { duration: 6000 });
    else if (complete) toast('글자 인식을 마쳤습니다. 틀린 글자가 있을 수 있습니다.', { duration: 4000 });
    else toast(`${s.done}쪽을 읽어 두었습니다. ⋮ 메뉴에서 이어 할 수 있습니다.`, { duration: 4000 });
  } catch (e) {
    console.error(e);
    r.setLoading(null);
    toast('전자책으로 정리하지 못했습니다.');
  }
  pushOcr(doc).catch((e) => console.warn('글자 인식 결과를 올리지 못했습니다', e));
}
