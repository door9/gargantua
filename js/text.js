// 본문 글자 위치 계산 — 하이라이트·메모·읽던 위치는 모두 '구획 안 몇 번째 글자'로 저장한다.
// 화면 장식([data-gui])은 세지 않으므로 줄글 보기와 전자책 보기에서 같은 위치를 가리킨다.

const FILTER = {
  acceptNode(node) {
    if (node.nodeType === 1) {
      if (node.hasAttribute('data-gui')) return NodeFilter.FILTER_REJECT;
      const tag = node.tagName;
      if (tag === 'STYLE' || tag === 'SCRIPT' || tag === 'TEMPLATE') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_SKIP;
    }
    return NodeFilter.FILTER_ACCEPT;
  },
};

const cache = new WeakMap();

export function textIndex(root) {
  let idx = cache.get(root);
  if (idx) return idx;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, FILTER);
  const nodes = [];
  const starts = [];
  const parts = [];
  let total = 0;
  let n;
  while ((n = walker.nextNode())) {
    nodes.push(n);
    starts.push(total);
    parts.push(n.data);
    total += n.data.length;
  }
  idx = { nodes, starts, length: total, _text: null, parts };
  cache.set(root, idx);
  return idx;
}

export function textOf(root) {
  const idx = textIndex(root);
  if (idx._text == null) {
    idx._text = idx.parts.join('');
    idx.parts = null;
  }
  return idx._text;
}

export function invalidateText(root) {
  cache.delete(root);
}

// 위치 → 글자 칸
function locate(idx, offset) {
  const { nodes, starts } = idx;
  if (!nodes.length) return null;
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  const node = nodes[lo];
  return { node, offset: Math.min(node.data.length, Math.max(0, offset - starts[lo])) };
}

export function rangeFromOffsets(root, start, end) {
  const idx = textIndex(root);
  if (!idx.nodes.length) return null;
  start = Math.max(0, Math.min(start, idx.length));
  end = Math.max(start, Math.min(end, idx.length));
  const a = locate(idx, start);
  // 끝 위치는 앞 칸의 끝에 붙인다(다음 칸 0번째로 넘기면 빈 줄이 칠해진다)
  const b = locate(idx, end > start ? end - 1 : end);
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  if (end > start) range.setEnd(b.node, Math.min(b.node.data.length, b.offset + 1));
  else range.setEnd(a.node, a.offset);
  return range;
}

export function pointAt(root, offset) {
  const idx = textIndex(root);
  return locate(idx, Math.max(0, Math.min(offset, idx.length)));
}

// 경계점(노드, 위치) → 구획 안 글자 위치
export function offsetOfBoundary(root, container, offset) {
  const idx = textIndex(root);
  if (container.nodeType === 3) {
    const i = indexOfNode(idx, container);
    if (i >= 0) return idx.starts[i] + Math.min(offset, container.data.length);
  }
  if (!root.contains(container)) {
    const pos = root.compareDocumentPosition(container);
    return pos & Node.DOCUMENT_POSITION_PRECEDING ? 0 : idx.length;
  }
  // 요소 경계 — 그 뒤 첫 글자 칸을 찾는다
  const probe = document.createRange();
  probe.setStart(container, offset);
  probe.collapse(true);
  let lo = 0;
  let hi = idx.nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const cmp = probe.comparePoint(idx.nodes[mid], 0);
    // cmp < 0: 이 글자 칸 시작이 경계보다 앞
    if (cmp < 0) lo = mid + 1; else hi = mid;
  }
  if (lo > 0) {
    // 앞 칸이 경계를 품고 있으면(경계가 그 칸 안쪽) 그 칸 끝
    const prev = idx.nodes[lo - 1];
    if (probe.comparePoint(prev, prev.data.length) >= 0) return idx.starts[lo - 1] + prev.data.length;
  }
  return lo < idx.nodes.length ? idx.starts[lo] : idx.length;
}

const nodeIndexCache = new WeakMap();
function indexOfNode(idx, node) {
  let map = nodeIndexCache.get(idx);
  if (!map) {
    map = new Map();
    idx.nodes.forEach((n, i) => map.set(n, i));
    nodeIndexCache.set(idx, map);
  }
  const i = map.get(node);
  return i == null ? -1 : i;
}

export function offsetsFromRange(root, range) {
  const start = offsetOfBoundary(root, range.startContainer, range.startOffset);
  const end = offsetOfBoundary(root, range.endContainer, range.endOffset);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

export function describe(root, start, end, ctx = 32) {
  const text = textOf(root);
  return {
    start,
    end,
    quote: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - ctx), start),
    suffix: text.slice(end, end + ctx),
  };
}

// ── 저장된 위치 다시 찾기(문서 변환 방식이 바뀌어도 인용문으로 찾아낸다) ──
const INVISIBLE = /[­​-‍⁠﻿]/;
const SPACE = /[\s 　]/;

function normalizeWithMap(text) {
  let out = '';
  const map = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (INVISIBLE.test(ch)) continue;
    if (SPACE.test(ch)) {
      if (lastSpace) continue;
      out += ' ';
      map.push(i);
      lastSpace = true;
    } else {
      out += ch;
      map.push(i);
      lastSpace = false;
    }
  }
  return { s: out, map };
}

function normalize(text) {
  return normalizeWithMap(text).s;
}

function commonSuffixLen(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefixLen(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function bestMatch(text, quote, prefix, suffix, hint) {
  if (!quote) return null;
  let best = null;
  let from = 0;
  let count = 0;
  while (count < 3000) {
    const i = text.indexOf(quote, from);
    if (i < 0) break;
    count++;
    const before = text.slice(Math.max(0, i - prefix.length), i);
    const after = text.slice(i + quote.length, i + quote.length + suffix.length);
    const ctxScore = commonSuffixLen(before, prefix) + commonPrefixLen(after, suffix);
    const dist = Math.abs(i - hint) / Math.max(1, text.length);
    const score = ctxScore * 2 - dist * 40;
    if (!best || score > best.score) best = { start: i, end: i + quote.length, score };
    from = i + 1;
  }
  return best;
}

export function resolveAnchor(text, anchor) {
  if (!anchor) return null;
  const quote = anchor.quote || '';
  const { start, end } = anchor;
  if (Number.isInteger(start) && Number.isInteger(end) && end > start && end <= text.length && text.slice(start, end) === quote) {
    return { start, end };
  }
  if (!quote.trim()) return null;
  const hint = Number.isInteger(start) ? start : (anchor.hint || 0);
  const exact = bestMatch(text, quote, anchor.prefix || '', anchor.suffix || '', hint);
  if (exact) return { start: exact.start, end: exact.end };
  const norm = normalizeWithMap(text);
  const nq = normalize(quote).trim();
  if (!nq) return null;
  let normHint = 0;
  if (hint > 0) {
    let lo = 0;
    let hi = norm.map.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (norm.map[mid] < hint) lo = mid + 1; else hi = mid;
    }
    normHint = lo;
  }
  const m = bestMatch(norm.s, nq, normalize(anchor.prefix || ''), normalize(anchor.suffix || ''), normHint);
  if (!m) return null;
  return { start: norm.map[m.start], end: norm.map[m.end - 1] + 1 };
}

// 화면 좌표의 글자 위치
export function caretFromPoint(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p && p.offsetNode) return { node: p.offsetNode, offset: p.offset };
  }
  if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) return { node: r.startContainer, offset: r.startOffset };
  }
  return null;
}

// 문장 경계(읽어주기·인용용)
export function sentenceBounds(text, offset) {
  const enders = /[.!?。！？…]["'”’)\]]*\s|\n/g;
  let start = 0;
  let m;
  enders.lastIndex = 0;
  while ((m = enders.exec(text))) {
    const end = m.index + m[0].length;
    if (end > offset) return { start, end };
    start = end;
  }
  return { start, end: text.length };
}

// 화면에 상자가 있는 글자 한 칸(문단 사이 줄바꿈처럼 안 보이는 글자면 뒤로, 없으면 앞으로 찾는다)
export function visibleRangeAt(root, offset, { span = 4000 } = {}) {
  const idx = textIndex(root);
  if (!idx.nodes.length) return null;
  const r = document.createRange();
  const hasBox = () => {
    for (const rc of r.getClientRects()) if (rc.width || rc.height) return true;
    return false;
  };
  const tryAt = (o) => {
    const p = locate(idx, o);
    if (!p || p.offset >= p.node.data.length) return false;
    if (/\s/.test(p.node.data[p.offset]) && p.node.data.trim() === '') return false;
    r.setStart(p.node, p.offset);
    r.setEnd(p.node, p.offset + 1);
    return hasBox();
  };
  const start = Math.max(0, Math.min(offset, idx.length - 1));
  // 칸 단위로 건너뛰며 앞쪽(뒤 글자)부터
  let i = indexOfOffset(idx, start);
  let o = start;
  for (let n = 0; i < idx.nodes.length && o - start <= span; n++) {
    const node = idx.nodes[i];
    const end = idx.starts[i] + node.data.length;
    if (node.data.trim()) {
      for (let k = o; k < end && k - start <= span; k++) if (tryAt(k)) return r;
    }
    i++;
    o = idx.starts[i] ?? idx.length;
  }
  for (let k = start - 1; k >= Math.max(0, start - span); k--) if (tryAt(k)) return r;
  return null;
}

function indexOfOffset(idx, offset) {
  let lo = 0;
  let hi = idx.nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (idx.starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}
