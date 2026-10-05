// 노트: 모든 문서의 하이라이트·메모를 한곳에서 — 찾기, 문서·색·태그로 거르기, 내보내기
import { h, esc, fmtDate, copyText, toast, downloadBlob } from '../util.js';
import { ico } from '../icons.js';
import { state, allLiveAnns, saveAnn, removeAnn, restoreAnn, saveRev } from '../store.js';
import { menu, infoButton } from '../ui/overlay.js';
import { openDoc } from '../main.js';
import { coverEl } from './library.js';
import { noteEditor, citeText, tagsOf, noteHtml, shareQuoteCard } from '../reader/actions.js';
import { exportNotesMarkdown } from './notes-export.js';

const COLOR_NAMES = ['노랑', '민트', '분홍', '파랑'];
const f = { q: '', doc: '', color: -1, notesOnly: false, tag: '', sort: 'doc' };
let root = null;
let listBox = null;

export function annWhere(ann) {
  const doc = state.docs.get(ann.docId);
  const info = state.info.get(ann.docId);
  const a = ann.anchor || {};
  if (doc?.format === 'pdf') return a.p != null ? `${a.p + 1}쪽` : '';
  if (!info?.starts || a.s == null) return '';
  const g = (info.starts[a.s] ?? 0) + (a.start ?? a.o ?? 0);
  const pct = Math.min(100, Math.round((g / Math.max(1, info.chars)) * 100));
  let title = '';
  for (const [st, t] of info.chaps || []) { if (st <= g) title = t; else break; }
  return info.chaps?.length > 1 && title ? `${title} · ${pct}%` : `${pct}%`;
}

function orderKey(ann) {
  const info = state.info.get(ann.docId);
  const a = ann.anchor || {};
  if (a.p != null) return a.p * 1e7 + (a.start || 0);
  return (info?.starts?.[a.s] ?? 0) + (a.start ?? 0);
}

export async function render(container) {
  root = container;
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  if (params.get('doc')) f.doc = params.get('doc');
  const exportBtn = h('button', { class: 'gicon', 'aria-label': '내보내기', title: '보이는 노트 내보내기', html: ico('upload') });
  exportBtn.addEventListener('click', () => exportMenu(exportBtn));
  container.append(
    h('header', { class: 'vhead' }, h('h1', null, '노트'), infoButton('모든 문서의 하이라이트와 메모가 여기에 모입니다. 메모에 <b>#태그</b>를 쓰면 태그로 모아 볼 수 있습니다. 카드를 누르면 본문의 그 자리로 갑니다.'), exportBtn),
    (listBox = h('div', { class: 'vbody' })));
  fill();
}

export function destroy() { root = null; }
export function refresh() { if (root) fill(true); }

function filtered() {
  let anns = allLiveAnns().filter((a) => a.kind === 'hl');
  if (f.doc) anns = anns.filter((a) => a.docId === f.doc);
  if (f.color >= 0) anns = anns.filter((a) => (a.color || 0) === f.color);
  if (f.notesOnly) anns = anns.filter((a) => a.note);
  if (f.tag) anns = anns.filter((a) => tagsOf(a.note).includes(f.tag));
  const q = f.q.trim().toLowerCase();
  if (q) anns = anns.filter((a) => `${a.anchor?.quote || ''} ${a.note || ''} ${state.docs.get(a.docId)?.title || ''}`.toLowerCase().includes(q));
  return anns;
}

function fill(keepInput = false) {
  const box = listBox;
  if (!box) return;
  const all = allLiveAnns().filter((a) => a.kind === 'hl');
  const activeSel = keepInput && document.activeElement?.classList.contains('notes-search') ? document.activeElement.selectionStart : null;
  box.textContent = '';
  if (!all.length) {
    box.append(h('div', { class: 'lib-empty' },
      h('h2', null, '아직 노트가 없습니다'),
      h('p', null, '책을 읽다가 마음에 남는 문장을 길게 눌러 선택하고 색을 고르면 이곳에 모입니다. 메모를 붙이면 생각까지 함께 남습니다.')));
    return;
  }
  const search = h('input', { class: 'gfield notes-search', type: 'search', placeholder: '문장·메모 찾기', value: f.q });
  search.addEventListener('input', () => { f.q = search.value; renderList(); });
  const docsWith = [...new Set(all.map((a) => a.docId))].map((id) => state.docs.get(id)).filter(Boolean).sort((a, b) => a.title.localeCompare(b.title, 'ko'));
  const sel = h('select', { class: 'gfield sel-inline', 'aria-label': '문서 고르기' }, h('option', { value: '' }, '모든 문서'), ...docsWith.map((d) => h('option', { value: d.id }, d.title)));
  sel.value = f.doc;
  sel.addEventListener('change', () => { f.doc = sel.value; fill(); });
  const chips = h('div', { class: 'chips' }, sel,
    h('button', { class: `gchip${f.notesOnly ? ' on' : ''}`, onclick: () => { f.notesOnly = !f.notesOnly; fill(); } }, '메모만'),
    ...COLOR_NAMES.map((name, i) => h('button', { class: `gchip dot c${i}${f.color === i ? ' on' : ''}`, 'aria-label': name, onclick: () => { f.color = f.color === i ? -1 : i; fill(); } })),
    h('button', { class: 'gchip', onclick: () => { f.sort = f.sort === 'doc' ? 'recent' : 'doc'; fill(); } }, f.sort === 'doc' ? '문서별' : '최근 순'));
  const tagCounts = new Map();
  for (const a of all) for (const t of tagsOf(a.note)) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
  const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  const tagRow = tags.length ? h('div', { class: 'tag-row' }, ...tags.map(([t, n]) => h('button', { class: `tag-chip${f.tag === t ? ' on' : ''}`, onclick: () => { f.tag = f.tag === t ? '' : t; fill(); } }, `#${t} ${n}`))) : null;
  const countLine = h('p', { class: 'note-count' });
  const list = h('div');
  box.append(h('div', { class: 'note-tools' }, h('div', { class: 'search-box', html: ico('search') }, search), chips, tagRow), countLine, list);
  if (activeSel != null) { search.focus(); search.setSelectionRange(activeSel, activeSel); }

  function renderList() {
    const anns = filtered();
    countLine.textContent = `하이라이트 ${anns.length}개 · 메모 ${anns.filter((a) => a.note).length}개`;
    list.textContent = '';
    if (!anns.length) { list.append(h('p', { class: 'empty-note' }, '조건에 맞는 노트가 없습니다.')); return; }
    if (f.sort === 'recent') {
      anns.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      for (const a of anns.slice(0, 600)) list.append(noteCard(a, true));
      return;
    }
    const groups = new Map();
    for (const a of anns) {
      if (!groups.has(a.docId)) groups.set(a.docId, []);
      groups.get(a.docId).push(a);
    }
    const ordered = [...groups.entries()].sort((x, y) => Math.max(...y[1].map((a) => a.updatedAt || 0)) - Math.max(...x[1].map((a) => a.updatedAt || 0)));
    for (const [docId, items] of ordered) {
      const doc = state.docs.get(docId);
      items.sort((a, b) => orderKey(a) - orderKey(b));
      const g = h('section', { class: 'note-group' },
        h('div', { class: 'note-group-head', onclick: () => openDoc(docId) }, coverEl(doc), h('div', null, h('b', null, doc.title), h('br'), h('small', null, `${items.length}개`))));
      for (const a of items) g.append(noteCard(a, false));
      list.append(g);
    }
  }
  renderList();
}

function noteCard(a, showDoc) {
  const doc = state.docs.get(a.docId);
  const more = h('button', { class: 'gicon', 'aria-label': '더보기', html: ico('more') });
  more.addEventListener('click', () => cardMenu(more, a));
  const where = annWhere(a);
  const rev = state.rev.get(a.id);
  return h('div', { class: `note-card c${a.color || 0}` },
    h('div', { class: 'stripe' }),
    h('div', null,
      h('div', { class: 'q', role: 'button', tabindex: '0', onclick: () => openDoc(a.docId, { ann: a.id }), onkeydown: (e) => { if (e.key === 'Enter') openDoc(a.docId, { ann: a.id }); } }, a.anchor?.quote || ''),
      a.note ? h('div', { class: 'n', html: noteHtml(a.note) }) : null,
      h('div', { class: 'm' }, [showDoc ? doc?.title : '', where, fmtDate(a.createdAt), rev?.retired ? '되새기기 제외' : ''].filter(Boolean).join(' · '))),
    more);
}

function cardMenu(anchor, a) {
  const rev = state.rev.get(a.id);
  menu(anchor, [
    { label: '본문에서 보기', icon: 'library', onClick: () => openDoc(a.docId, { ann: a.id }) },
    { label: a.note ? '메모 수정' : '메모 쓰기', icon: 'note', onClick: async () => {
      const body = await noteEditor({ quote: a.anchor?.quote || '', value: a.note || '' });
      if (body == null) return;
      await saveAnn({ id: a.id, note: body.trim() });
    } },
    ...COLOR_NAMES.map((name, i) => ({ label: `${name}으로`, checked: (a.color || 0) === i, onClick: () => saveAnn({ id: a.id, color: i }) })),
    { divider: true },
    { label: '인용 복사', icon: 'quote', onClick: async () => {
      const doc = state.docs.get(a.docId);
      if (await copyText(citeText(doc, a, annWhere(a)))) toast('복사했습니다.', { duration: 1200 });
    } },
    { label: '문장 카드 이미지', icon: 'sparkle', onClick: () => shareQuoteCard(state.docs.get(a.docId), a, annWhere(a)) },
    { label: rev?.retired ? '되새기기에 다시 넣기' : '되새기기에서 빼기', icon: 'review', onClick: () => saveRev(a.id, { retired: !rev?.retired }) },
    { label: '삭제', icon: 'trash', danger: true, onClick: async () => {
      const snap = { ...a };
      await removeAnn(a.id);
      toast('하이라이트를 지웠습니다.', { action: '되돌리기', onAction: () => restoreAnn(snap) });
    } },
  ]);
}

function exportMenu(anchor) {
  const anns = filtered();
  if (!anns.length) { toast('내보낼 노트가 없습니다.'); return; }
  const groups = new Map();
  for (const a of anns) {
    if (!groups.has(a.docId)) groups.set(a.docId, []);
    groups.get(a.docId).push(a);
  }
  const md = exportNotesMarkdown([...groups.entries()].map(([docId, items]) => ({
    doc: state.docs.get(docId),
    anns: items.sort((x, y) => orderKey(x) - orderKey(y)),
    where: annWhere,
  })));
  menu(anchor, [
    { label: `Markdown으로 복사 (${anns.length}개)`, icon: 'copy', onClick: async () => { if (await copyText(md)) toast('복사했습니다.'); } },
    { label: 'Markdown 파일로 저장', icon: 'download', onClick: () => downloadBlob(new Blob([md], { type: 'text/markdown' }), `Gargantua 노트 ${new Date().toISOString().slice(0, 10)}.md`) },
  ], { title: '보이는 노트 내보내기' });
}

export { esc };
