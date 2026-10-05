// 변환기 공용: 안전 정리(DOMPurify), 책 CSS 가두기, 구획 나누기, 구획 분석
import DOMPurify from '../../vendor/purify.mjs';
import { textIndex, textOf } from '../text.js';

export const PARSER_VERSION = 5;

const PURIFY = {
  USE_PROFILES: { html: true, svg: true },
  FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'option',
    'video', 'audio', 'source', 'track', 'link', 'meta', 'base', 'canvas', 'dialog', 'template', 'frame', 'frameset', 'noscript', 'foreignObject', 'use', 'image'],
  FORBID_ATTR: ['srcset', 'ping', 'formaction', 'background', 'poster', 'src', 'action', 'xlink:href', 'autofocus', 'tabindex', 'contenteditable', 'draggable'],
  ALLOW_DATA_ATTR: true,
  ADD_ATTR: ['data-g-src', 'data-epub-type'],
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: true,
};

export function purify(html) {
  return DOMPurify.sanitize(html, PURIFY);
}

const HTML_DOC = () => document.implementation.createHTMLDocument('');

// HTML 문자열 → 화면에 넣을 조각(렌더러와 똑같은 방법으로 해석해야 글자 위치가 맞는다)
export function fragmentFrom(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

export function rootFrom(html) {
  const div = document.createElement('div');
  div.append(fragmentFrom(html));
  return div;
}

// style="" 속성에서 위험·방해 요소 제거
export function cleanInlineStyle(value) {
  if (!value) return '';
  return value
    .replace(/url\s*\([^)]*\)/gi, 'none')
    .replace(/position\s*:\s*(fixed|sticky)/gi, 'position: static')
    .replace(/expression\s*\(/gi, '(')
    .replace(/behavior\s*:/gi, 'x:');
}

// ── 책 CSS를 .g-book 안으로 가두기 ──
function splitSelectors(text) {
  const out = [];
  let depth = 0;
  let cur = '';
  let quote = '';
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function scopeSelector(sel, scope) {
  let s = sel.trim();
  if (!s) return null;
  if (/^@/.test(s)) return null;
  // html / :root
  const rootMatch = /^(html|:root)\b/i.exec(s);
  if (rootMatch) {
    s = s.slice(rootMatch[0].length);
    const bodyAfter = /^\s*>?\s*body\b/i.exec(s);
    if (bodyAfter) return `${scope} .g-body${s.slice(bodyAfter[0].length)}`;
    return s.trim() ? `${scope}${/^[\s>+~]/.test(s) ? '' : ' '}${s}` : scope;
  }
  const bodyMatch = /^body\b/i.exec(s);
  if (bodyMatch) return `${scope} .g-body${s.slice(bodyMatch[0].length)}`;
  return `${scope} ${s}`;
}

const DROP_PROPS = new Set(['color', 'background', 'background-color', 'background-image', 'columns', 'column-count', 'column-width',
  'column-gap', 'column-fill', 'column-rule', 'column-span', 'cursor', 'pointer-events', 'user-select', '-webkit-user-select',
  '-epub-user-select', 'z-index', 'filter', 'mix-blend-mode', 'transition', 'animation', 'will-change', 'content-visibility']);

function fixDeclarations(style, { isRootRule }) {
  const remove = [];
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    const value = style.getPropertyValue(prop);
    if (DROP_PROPS.has(prop) || prop.startsWith('column-rule') || prop.startsWith('background-')) { remove.push(prop); continue; }
    if (prop === 'position' && /fixed|sticky|absolute/i.test(value)) { remove.push(prop); continue; }
    if (isRootRule && /^(height|min-height|max-height|width|min-width|max-width|margin.*|padding.*|overflow.*)$/.test(prop)) { remove.push(prop); continue; }
    if (/^(height|max-height)$/.test(prop) && /vh|%/.test(value)) { remove.push(prop); continue; }
    if (/^(top|left|right|bottom)$/.test(prop) && /vh|vw/.test(value)) { remove.push(prop); continue; }
  }
  for (const prop of remove) style.removeProperty(prop);
  // 글자 크기는 사용자가 정한 크기를 기준으로(rem·px·pt → em)
  const fs = style.getPropertyValue('font-size');
  if (fs) {
    const m = /^(-?[\d.]+)(px|pt|rem)$/.exec(fs.trim());
    if (m) {
      const n = parseFloat(m[1]);
      const em = m[2] === 'px' ? n / 16 : m[2] === 'pt' ? (n * 4 / 3) / 16 : n;
      style.setProperty('font-size', `${+em.toFixed(4)}em`, style.getPropertyPriority('font-size'));
    }
  }
  for (let i = 0; i < style.length; i++) {
    const prop = style[i];
    const value = style.getPropertyValue(prop);
    if (/rem\b/.test(value)) style.setProperty(prop, value.replace(/(-?[\d.]+)rem\b/g, '$1em'), style.getPropertyPriority(prop));
  }
}

function rewriteUrls(text, resolveUrl) {
  return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, q, url) => {
    const key = resolveUrl ? resolveUrl(url.trim()) : null;
    return key ? `url("garg-res:${key}")` : 'none';
  });
}

function serializeRules(rules, scope, resolveUrl) {
  let out = '';
  for (const rule of rules) {
    try {
      if (rule instanceof CSSStyleRule) {
        const sels = splitSelectors(rule.selectorText).map((s) => scopeSelector(s, scope)).filter(Boolean);
        if (!sels.length) continue;
        const isRootRule = splitSelectors(rule.selectorText).some((s) => /^(html|body|:root)\b/i.test(s.trim()) && !/\s/.test(s.trim()));
        fixDeclarations(rule.style, { isRootRule });
        const body = rule.style.cssText;
        if (!body.trim()) continue;
        out += `${sels.join(', ')} { ${rewriteUrls(body, resolveUrl)} }\n`;
      } else if (typeof CSSMediaRule !== 'undefined' && rule instanceof CSSMediaRule) {
        const inner = serializeRules(rule.cssRules, scope, resolveUrl);
        if (inner) out += `@media ${rule.conditionText || rule.media.mediaText} {\n${inner}}\n`;
      } else if (typeof CSSSupportsRule !== 'undefined' && rule instanceof CSSSupportsRule) {
        const inner = serializeRules(rule.cssRules, scope, resolveUrl);
        if (inner) out += `@supports ${rule.conditionText} {\n${inner}}\n`;
      } else if (typeof CSSFontFaceRule !== 'undefined' && rule instanceof CSSFontFaceRule) {
        out += `@font-face { ${rewriteUrls(rule.style.cssText, resolveUrl)} }\n`;
      } else if (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) {
        out += serializeRules(rule.cssRules, scope, resolveUrl);
      }
      // @page·@import·@keyframes·@namespace 는 버린다
    } catch {
      // 해석 못 하는 규칙은 건너뛴다
    }
  }
  return out;
}

export function scopeCss(cssText, resolveUrl, scope = '.g-book') {
  if (!cssText || !cssText.trim()) return '';
  let sheet;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText.replace(/@import[^;]+;/gi, '').replace(/@namespace[^;]+;/gi, ''));
  } catch {
    return '';
  }
  return serializeRules(sheet.cssRules, scope, resolveUrl);
}

// ── 경로 ──
export function joinPath(base, rel) {
  if (!rel) return base;
  if (rel.startsWith('/')) return normalizePath(rel.slice(1));
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  return normalizePath(dir + rel);
}
export function normalizePath(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop(); else parts.push(seg);
  }
  return parts.join('/');
}
export function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ── 큰 문서를 구획으로 나누기(제목 앞에서 끊기를 선호) ──
const HEADING = /^H[1-6]$/;
export function splitIntoSections(root, { target = 24000, min = 9000 } = {}) {
  const groups = [];
  let cur = [];
  let chars = 0;
  for (const child of [...root.childNodes]) {
    if (child.nodeType === 3 && !child.data.trim()) { cur.push(child); continue; }
    const len = (child.textContent || '').length;
    const isHeading = child.nodeType === 1 && (HEADING.test(child.tagName) || child.dataset?.chapter);
    if (cur.length && ((isHeading && chars >= min) || chars >= target)) {
      groups.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(child);
    chars += len;
  }
  if (cur.length || !groups.length) groups.push(cur);
  return groups.map((nodes) => {
    const box = document.createElement('div');
    for (const n of nodes) box.append(n);
    return box.innerHTML;
  });
}

// 문단·제목 사이에 줄바꿈 글자를 넣는다(화면은 그대로, 찾기·인용·읽어주기에서 문단이 붙지 않게)
const BREAK_AFTER = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION', 'DT', 'DD',
  'DIV', 'SECTION', 'ASIDE', 'HEADER', 'FOOTER', 'TABLE', 'UL', 'OL', 'DL', 'HR', 'ARTICLE', 'NAV', 'ADDRESS', 'CENTER', 'TR']);
export function addBlockBreaks(html) {
  const root = rootFrom(html);
  let changed = false;
  for (const el of [...root.querySelectorAll('*')]) {
    if (!BREAK_AFTER.has(el.tagName) || el.closest('pre') !== el && el.closest('pre')) continue;
    const next = el.nextSibling;
    if (next && next.nodeType === 3 && /^\s/.test(next.data)) continue;
    if (!next && !el.parentElement) continue;
    const parent = el.parentNode;
    if (!parent || parent.tagName === 'TABLE' || parent.tagName === 'TBODY' || parent.tagName === 'THEAD' || parent.tagName === 'TFOOT' || parent.tagName === 'UL' || parent.tagName === 'OL' || parent.tagName === 'DL') {
      if (el.tagName !== 'LI' && el.tagName !== 'TR' && el.tagName !== 'DT' && el.tagName !== 'DD') continue;
    }
    el.after(document.createTextNode('\n'));
    changed = true;
  }
  for (const cell of [...root.querySelectorAll('td, th')]) {
    const next = cell.nextSibling;
    if (next && next.nodeType === 1) { cell.after(document.createTextNode(' ')); changed = true; }
  }
  return changed ? root.innerHTML : html;
}

// 구획 분석: 글자 수, 본문 글, 제목 목록, id → 위치
export function analyzeSection(html) {
  const root = rootFrom(html);
  const idx = textIndex(root);
  const text = textOf(root);
  const headings = [];
  for (const el of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const title = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    headings.push({ level: Number(el.tagName[1]), title: title.slice(0, 140), o: offsetOfElement(root, el, idx) });
  }
  const ids = new Map();
  for (const el of root.querySelectorAll('[id]')) {
    if (!ids.has(el.id)) ids.set(el.id, offsetOfElement(root, el, idx));
  }
  return { text, chars: idx.length, headings, ids };
}

function offsetOfElement(root, el, idx) {
  const { nodes, starts } = idx;
  // 요소 안이나 뒤의 첫 글자 칸
  for (let lo = 0, hi = nodes.length; ;) {
    if (lo >= hi) return lo < nodes.length ? starts[lo] : idx.length;
    const mid = (lo + hi) >> 1;
    const rel = el.compareDocumentPosition(nodes[mid]);
    const nodeBefore = (rel & Node.DOCUMENT_POSITION_PRECEDING) && !(rel & Node.DOCUMENT_POSITION_CONTAINS);
    if (nodeBefore) lo = mid + 1; else hi = mid;
  }
}

export function newHtmlDoc() {
  return HTML_DOC();
}

export function blobFrom(bytes, type) {
  return new Blob([bytes], { type: type || 'application/octet-stream' });
}

export const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  avif: 'image/avif', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', css: 'text/css',
};
export function mimeOf(path, fallback = '') {
  const m = /\.([a-z0-9]+)$/i.exec(path || '');
  return (m && MIME[m[1].toLowerCase()]) || fallback;
}

// 표지 썸네일(서재 목록용)
export async function makeThumb(blob, { width = 240, height = 340 } = {}) {
  try {
    const bmp = await createImageBitmap(blob);
    const ratio = Math.min(1, Math.max(width / bmp.width, height / bmp.height));
    const w = Math.max(1, Math.round(bmp.width * ratio));
    const h = Math.max(1, Math.round(bmp.height * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(w, width);
    canvas.height = Math.min(h, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    bmp.close?.();
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
  } catch {
    return null;
  }
}

export function decodeText(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('euc-kr', { fatal: false }).decode(bytes); // 브라우저의 euc-kr = CP949
    } catch {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }
}
