// 띄어쓰기 고침(2026-11-24 사용자 "본문에 띄어쓰기 오류가 있다면 바로잡도록") — 원본 파일·변환본은 그대로 두고,
// 문서를 펼칠 때 본문 글에 빈칸을 넣거나 뺀다. 읽기 화면·찾기·인용·읽어주기가 모두 고친 글을 본다.
//
// 기록: 하이라이트와 같은 칸(anns)에 kind 'fix' 로 하나씩 — 기록마다 따로 동기화되고(늦게 고친 쪽이 이김), 되돌리면 지움 표시.
//   { id, docId, kind: 'fix', op: 'ins' | 'del', anchor: { s, o, before, after, ch } }
//   s·o    = 원래 글(변환한 그대로)의 구획·글자 위치. ins = o 번째 글자 앞에 빈칸을 넣는다, del = o 번째 글자(빈칸 ch)를 뺀다
//   before·after = 그 자리 앞뒤의 원래 글(16자) — 변환 방식이 바뀌거나 원본 파일을 바꿔 위치가 달라지면 이 글귀로 다시 찾는다.
//                  못 찾으면(새 원본이 이미 띄어 써 있는 등) 그 고침은 쓰지 않는다
// 위치: 하이라이트·책갈피·읽던 자리는 '고친 글' 기준이다(화면이 보는 글). 고칠 때 그 구획의 하이라이트를 함께 옮긴다(reader/index.js applyFixChange).
import { liveAnns } from './store.js';
import { rootFrom } from './parse/common.js';
import { textIndex, textOf } from './text.js';

export const FIX_CTX = 16;
export const SPACE_CH = /[\s 　]/;

export function fixesOf(docId) {
  return liveAnns(docId).filter((a) => a.kind === 'fix' && a.anchor && (a.op === 'ins' || a.op === 'del'));
}

// 고침 묶음이 달라졌는지 보는 표
export function fixSig(fixes) {
  return fixes.map((f) => `${f.id}:${f.updatedAt || 0}`).sort().join('|');
}

// 새 고침 기록의 자리(원래 글 기준)
export function fixAnchor(text, s, o, op) {
  const before = text.slice(Math.max(0, o - FIX_CTX), o);
  if (op === 'del') return { s, o, before, after: text.slice(o + 1, o + 1 + FIX_CTX), ch: text[o] };
  return { s, o, before, after: text.slice(o, o + FIX_CTX) };
}

function fitsAt(text, f, o) {
  const a = f.anchor;
  if (!text || o < 0 || o > text.length) return false;
  if (text.slice(Math.max(0, o - a.before.length), o) !== a.before) return false;
  if (f.op === 'del') return SPACE_CH.test(text[o] || '') && text.slice(o + 1, o + 1 + a.after.length) === a.after;
  return o < text.length && text.slice(o, o + a.after.length) === a.after;
}

// 원래 자리에 글귀가 없으면(변환 방식·원본이 바뀜) 앞뒤 글귀로 다시 찾는다 — 원래 구획에서 가장 가까운 곳, 없으면 가까운 구획
function relocate(texts, f) {
  const a = f.anchor;
  const mid = f.op === 'del' ? (a.ch || ' ') : '';
  const needle = a.before + mid + a.after;
  if (a.before.length + a.after.length < 6) return null;
  let best = null;
  for (let s = 0; s < texts.length; s++) {
    const t = texts[s] || '';
    for (let i = t.indexOf(needle); i >= 0; i = t.indexOf(needle, i + 1)) {
      const o = i + a.before.length;
      const far = s === a.s ? Math.abs(o - (a.o || 0)) : 1e9 + Math.abs(s - (a.s || 0)) * 1e6 + o;
      if (!best || far < best.far) best = { s, o, far };
    }
  }
  return best;
}

// 원래 글에 고침들을 맞춰 본다 → { plan: Map(구획 → [{o, op, ids, moved}] 위치 오름차순), missing: [자리를 못 찾은 고침] }
export function planFixes(texts, fixes) {
  const plan = new Map();
  const missing = [];
  const at = new Map();
  for (const f of fixes) {
    const a = f.anchor;
    let s = a.s;
    let o = a.o;
    if (!(Number.isInteger(s) && Number.isInteger(o) && fitsAt(texts[s], f, o))) {
      const hit = relocate(texts, f);
      if (!hit) { missing.push(f); continue; }
      ({ s, o } = hit);
    }
    // 두 기기가 같은 자리를 따로 고쳤으면 한 번만 쓴다(되돌릴 때는 둘 다 지운다)
    const key = `${s}:${o}:${f.op}`;
    if (at.has(key)) { at.get(key).ids.push(f.id); continue; }
    const e = { o, op: f.op, ids: [f.id], moved: s !== a.s || o !== a.o };
    at.set(key, e);
    if (!plan.has(s)) plan.set(s, []);
    plan.get(s).push(e);
  }
  for (const list of plan.values()) list.sort((x, y) => x.o - y.o || (x.op === 'ins' ? -1 : 1));
  return { plan, missing };
}

// ── 원래 글 위치 ↔ 고친 글 위치(한 구획) ──
// 원래 글자 o(또는 경계 o)가 고친 글에서 있는 곳. 뺀 글자면 그 뒤 글자가 오는 곳
export function origToCur(edits, o) {
  let delta = 0;
  for (const e of edits || []) {
    if (e.o > o) break;
    if (e.op === 'ins') delta += 1;
    else if (e.o < o) delta -= 1;
  }
  return o + delta;
}

// 고친 글 c 번째 글자의 원래 위치. 넣은 빈칸이면 ins 에 그 고침
export function curToOrig(edits, c) {
  let delta = 0;
  for (const e of edits || []) {
    const cp = e.o + delta;
    if (c < cp) break;
    if (e.op === 'ins') {
      if (c === cp) return { o: e.o, ins: e };
      delta += 1;
    } else {
      delta -= 1;
    }
  }
  return { o: c - delta, ins: null };
}

// 위치 o 의 글자가 든 글자 칸(빈 칸은 건너뛴다)
function charAt(idx, o) {
  const { nodes, starts } = idx;
  if (!nodes.length) return null;
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= o) lo = mid; else hi = mid - 1;
  }
  while (lo < nodes.length && starts[lo] + nodes[lo].data.length <= o) lo++;
  return lo < nodes.length && starts[lo] <= o ? { node: nodes[lo], offset: o - starts[lo] } : null;
}

// 구획 HTML 하나 고치기(뒤에서부터 — 앞 고침의 위치가 밀리지 않게)
export function patchSectionHtml(html, edits) {
  const root = rootFrom(html);
  const idx = textIndex(root);
  for (let k = edits.length - 1; k >= 0; k--) {
    const e = edits[k];
    const p = charAt(idx, e.o);
    if (!p) continue;
    if (e.op === 'ins') p.node.insertData(p.offset, ' ');
    else if (SPACE_CH.test(p.node.data[p.offset] || '')) p.node.deleteData(p.offset, 1);
  }
  return root.innerHTML;
}

// 글만 고치기(서재 찾기 등 — 화면에 그리지 않는 곳)
export function patchText(text, edits) {
  let out = text;
  for (let k = edits.length - 1; k >= 0; k--) {
    const e = edits[k];
    if (e.op === 'ins') out = `${out.slice(0, e.o)} ${out.slice(e.o)}`;
    else if (SPACE_CH.test(out[e.o] || '')) out = out.slice(0, e.o) + out.slice(e.o + 1);
  }
  return out;
}

export function patchTexts(texts, plan) {
  if (!plan.size) return texts;
  return texts.map((t, s) => (plan.has(s) ? patchText(t, plan.get(s)) : t));
}

// 책 전체: 고친 구획의 HTML·글·글자 수, 구획 시작 위치·전체 글자 수, 제목·목차 위치, PDF 쪽 시작 위치를 고친 글 기준으로.
// 받은 book·texts 는 그대로 두고(변환본 보관용) 새 것을 돌려준다
export function patchBook(book, texts, plan) {
  if (!plan.size) return { book, texts };
  const sections = book.sections.slice();
  const out = texts.slice();
  for (const [s, edits] of plan) {
    const sec = sections[s];
    if (!sec) continue;
    const html = patchSectionHtml(sec.html, edits);
    const t = textOf(rootFrom(html));
    sections[s] = { ...sec, html, chars: t.length };
    out[s] = t;
  }
  let total = 0;
  for (let s = 0; s < sections.length; s++) {
    if (sections[s].start !== total) sections[s] = { ...sections[s], start: total };
    total += sections[s].chars;
  }
  const mapO = (s, o) => (plan.has(s) ? origToCur(plan.get(s), o) : o);
  const next = { ...book, sections, chars: total };
  if (book.headings) next.headings = book.headings.map((x) => (plan.has(x.s) ? { ...x, o: mapO(x.s, x.o) } : x));
  if (book.toc) next.toc = book.toc.map((x) => (plan.has(x.s) ? { ...x, o: mapO(x.s, x.o) } : x));
  if (book.pageStarts) {
    const base = book.sections;
    next.pageStarts = book.pageStarts.map((g) => {
      if (g >= book.chars) return total;
      let lo = 0;
      let hi = base.length - 1;
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if (base[m].start <= g) lo = m; else hi = m - 1;
      }
      return sections[lo].start + mapO(lo, g - base[lo].start);
    });
  }
  return { book: next, texts: out };
}
