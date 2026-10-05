// 서재 전체에서 찾기 — 모든 문서의 본문과 노트
import { h, esc, debounce, snippetAround, fmtCount } from '../util.js';
import { ico } from '../icons.js';
import { state, liveDocs, allLiveAnns } from '../store.js';
import { infoButton } from '../ui/overlay.js';
import { openDoc } from '../main.js';
import { searchableTexts } from '../docs.js';
import { annWhere } from './notes.js';

let root = null;
let q = '';
let scope = 'text';
let corpus = null;
let resultBox = null;
let runId = 0;

export async function render(container) {
  root = container;
  const input = h('input', { class: 'gfield', type: 'search', placeholder: '서재 전체에서 찾기', value: q, enterkeyhint: 'search', autofocus: true });
  const run = debounce(() => { q = input.value; search(); }, 300);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { run.cancel(); q = input.value; search(); } });
  const chips = h('div', { class: 'chips' });
  const paintChips = () => {
    chips.textContent = '';
    for (const [k, label] of [['text', '본문'], ['notes', '하이라이트·메모']]) {
      chips.append(h('button', { class: `gchip${scope === k ? ' on' : ''}`, onclick: () => { scope = k; paintChips(); search(); } }, label));
    }
  };
  paintChips();
  resultBox = h('div', { class: 'srch-res' });
  container.append(
    h('header', { class: 'vhead' }, h('h1', null, '찾기'), infoButton('서재에 있는 모든 문서의 본문, 또는 남긴 하이라이트·메모에서 낱말을 찾습니다. 결과를 누르면 그 자리로 가서 찾은 낱말을 표시합니다.')),
    h('div', { class: 'vbody' }, h('div', { class: 'search-box', html: ico('search') }, input), h('div', { style: 'margin-top:10px' }, chips), resultBox));
  setTimeout(() => input.focus(), 50);
  if (q) search();
}

export function destroy() { root = null; corpus = null; }
export function refresh() { corpus = null; }

async function loadCorpus() {
  if (corpus) return corpus;
  const out = [];
  let missing = 0;
  for (const doc of liveDocs()) {
    const t = await searchableTexts(doc);
    if (!t) { missing++; continue; }
    out.push({ doc, ...t });
  }
  corpus = { items: out, missing };
  return corpus;
}

async function search() {
  const my = ++runId;
  const box = resultBox;
  if (!box) return;
  const needle = q.trim().toLowerCase();
  box.textContent = '';
  if (!needle) return;
  if (scope === 'notes') {
    const anns = allLiveAnns().filter((a) => a.kind === 'hl' && `${a.anchor?.quote || ''}\n${a.note || ''}`.toLowerCase().includes(needle));
    if (!anns.length) { box.append(h('p', { class: 'empty-note' }, '찾은 노트가 없습니다.')); return; }
    const groups = new Map();
    for (const a of anns) { if (!groups.has(a.docId)) groups.set(a.docId, []); groups.get(a.docId).push(a); }
    for (const [docId, items] of groups) {
      const doc = state.docs.get(docId);
      const sec = h('section', null, h('div', { class: 'srch-doc-head' }, h('b', null, doc.title), h('small', null, `${items.length}개`)));
      for (const a of items) {
        const text = `${a.anchor?.quote || ''}${a.note ? `  — ${a.note}` : ''}`;
        const i = text.toLowerCase().indexOf(needle);
        const sn = snippetAround(text, i, i + needle.length, 60);
        sec.append(h('button', { class: 'srch-hit', onclick: () => openDoc(docId, { ann: a.id }) },
          h('span', { class: 'w' }, annWhere(a)),
          h('span', { html: `${esc(sn.before)}<mark>${esc(sn.hit)}</mark>${esc(sn.after)}` })));
      }
      box.append(sec);
    }
    return;
  }
  box.append(h('p', { class: 'empty-note' }, '찾는 중…'));
  const c = await loadCorpus();
  if (my !== runId) return;
  box.textContent = '';
  let totalDocs = 0;
  let totalHits = 0;
  for (const item of c.items) {
    const hits = [];
    let count = 0;
    item.texts.forEach((t, u) => {
      const low = (t || '').toLowerCase();
      let i = low.indexOf(needle);
      while (i >= 0) {
        count++;
        if (hits.length < 40) hits.push({ u, start: i, end: i + needle.length, text: t });
        i = low.indexOf(needle, i + needle.length);
      }
    });
    if (!count) continue;
    totalDocs++;
    totalHits += count;
    const sec = h('section', null, h('div', { class: 'srch-doc-head' }, h('b', null, item.doc.title), h('small', null, `${fmtCount(count)}곳`)));
    const shown = hits.slice(0, 4);
    const addHit = (hit) => {
      const sn = snippetAround(hit.text, hit.start, hit.end, 46);
      const where = item.kind === 'pdf' ? `${hit.u + 1}쪽` : `${Math.round(((item.book.sections[hit.u].start + hit.start) / Math.max(1, item.book.chars)) * 100)}%`;
      const params = item.kind === 'pdf' ? { p: hit.u, find: q.trim() } : { s: hit.u, o: hit.start, find: q.trim() };
      return h('button', { class: 'srch-hit', onclick: () => openDoc(item.doc.id, params) },
        h('span', { class: 'w' }, where),
        h('span', { html: `${esc(sn.before)}<mark>${esc(sn.hit)}</mark>${esc(sn.after)}` }));
    };
    for (const hit of shown) sec.append(addHit(hit));
    if (hits.length > shown.length) {
      const moreBtn = h('button', { class: 'gbtn ghost small', onclick: () => { moreBtn.remove(); for (const hit of hits.slice(shown.length)) sec.append(addHit(hit)); } }, `더 보기 (${Math.min(hits.length, 40) - shown.length})`);
      sec.append(moreBtn);
    }
    box.append(sec);
    if (totalDocs % 5 === 0) await new Promise((r) => setTimeout(r, 0));
    if (my !== runId) return;
  }
  if (!totalDocs) box.append(h('p', { class: 'empty-note' }, '찾은 결과가 없습니다.'));
  else box.prepend(h('p', { class: 'note-count' }, `${totalDocs}개 문서에서 ${fmtCount(totalHits)}곳`));
  if (c.missing) box.append(h('p', { class: 'srch-note' }, `아직 한 번도 열지 않았거나 원본을 받지 않은 문서 ${c.missing}개는 제외했습니다(한 번 열면 찾기에 포함됩니다).`));
}
