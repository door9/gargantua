// 한 구획 안에서 일부만 보이기(장 단위 보기, 아주 긴 장의 전자책 보기).
// 글은 지우지 않고 숨기기만 하므로 글자 위치는 그대로다.
import { offsetOfBoundary, textIndex } from '../text.js';

const BLOCK = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'DT', 'DD', 'BLOCKQUOTE', 'PRE', 'TABLE', 'FIGURE', 'IMG',
  'HR', 'DIV', 'SECTION', 'ASIDE', 'HEADER', 'FOOTER', 'NAV', 'OL', 'UL', 'DL', 'FIGCAPTION', 'ARTICLE', 'CENTER', 'ADDRESS',
  'DETAILS', 'SUMMARY', 'MAIN', 'HGROUP', 'svg', 'SVG']);

const isBlock = (el) => BLOCK.has(el.tagName);

export function leafBlocks(root) {
  const out = [];
  const visit = (el) => {
    let blockChild = false;
    for (const c of el.children) if (isBlock(c)) { blockChild = true; break; }
    if (!blockChild || el.tagName === 'TABLE' || el.tagName === 'PRE' || el.tagName === 'P') { out.push(el); return; }
    for (const n of el.childNodes) if (n.nodeType === 3 && n.data.trim()) { out.push(el); return; }
    for (const c of el.children) {
      if (c.hasAttribute('data-gui')) continue;
      if (isBlock(c)) visit(c); else out.push(c);
    }
  };
  for (const c of root.children) {
    if (c.hasAttribute('data-gui')) continue;
    if (isBlock(c)) visit(c); else out.push(c);
  }
  return out;
}

export function blockSpans(root) {
  const leaves = leafBlocks(root);
  return leaves.map((el) => ({
    el,
    start: offsetOfBoundary(root, el, 0),
    end: offsetOfBoundary(root, el, el.childNodes.length),
  }));
}

// [a, b) 밖의 블록 숨기기. a=0, b=전체면 모두 보이기
export function applyWindow(root, a, b) {
  for (const el of root.querySelectorAll('.g-hide')) el.classList.remove('g-hide');
  const total = textIndex(root).length;
  if (a <= 0 && b >= total) return;
  const spans = blockSpans(root);
  for (const sp of spans) {
    const empty = sp.end <= sp.start;
    const hide = empty ? (sp.start < a || sp.start >= b) : (sp.end <= a || sp.start >= b);
    if (hide) sp.el.classList.add('g-hide');
  }
  // 안이 전부 숨겨진 묶음 상자도 숨긴다
  const all = [...root.querySelectorAll('*')].reverse();
  for (const el of all) {
    if (el.classList.contains('g-hide') || !el.children.length) continue;
    let anyShown = false;
    for (const c of el.children) if (!c.classList.contains('g-hide') && !c.hasAttribute('data-gui')) { anyShown = true; break; }
    if (anyShown) continue;
    let text = false;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.data.trim()) { text = true; break; }
    if (!text) el.classList.add('g-hide');
  }
}

// 긴 구획을 대략 limit 글자씩 끊은 창 목록
export function windowsFor(root, limit) {
  const total = textIndex(root).length;
  if (total <= limit * 1.4) return [{ from: 0, to: total }];
  const spans = blockSpans(root);
  const wins = [];
  let from = 0;
  for (const sp of spans) {
    if (sp.start - from >= limit && sp.start > from) {
      wins.push({ from, to: sp.start });
      from = sp.start;
    }
  }
  wins.push({ from, to: total });
  return wins;
}
