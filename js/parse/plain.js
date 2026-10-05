// TXT·Markdown → HTML
import { marked } from '../../vendor/marked.mjs';
import { purify, splitIntoSections, newHtmlDoc, decodeText } from './common.js';

const CHAPTER_LINE = /^(?:제\s*[0-9一二三四五六七八九十百]+\s*[장부편화권막](?:\s.*)?|(?:chapter|part|book)\s+[0-9ivxlcdm]+\b.*|프롤로그|에필로그|서문|머리말|들어가며|들어가는\s*글|맺음말|나가며|후기|작가의\s*말|prologue|epilogue|preface|introduction|afterword)$/i;

export function parseText(bytes) {
  const text = decodeText(bytes).replace(/\r\n?/g, '\n');
  const hd = newHtmlDoc();
  const root = hd.createElement('div');
  const lines = text.split('\n');
  let blank = 0;
  let firstLine = '';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { blank++; continue; }
    if (!firstLine) firstLine = line.trim();
    const t = line.trim();
    const nextBlank = i + 1 >= lines.length || !lines[i + 1].trim();
    const isChapter = t.length <= 40 && CHAPTER_LINE.test(t) && (blank > 0 || i === 0) && nextBlank;
    const el = hd.createElement(isChapter ? 'h2' : 'p');
    // 앞쪽 들여쓰기 공백은 살린다
    const lead = /^[ 　\t]+/.exec(line);
    el.textContent = line.slice(lead ? lead[0].length : 0);
    if (lead && !isChapter) el.className = 'g-indent';
    if (blank > 0 && root.childNodes.length) el.classList.add('g-gap');
    root.append(el);
    blank = 0;
  }
  const sections = splitIntoSections(root).map((html) => ({ html: purify(html), bodyClass: 'txt', styles: [] }));
  return { book: { format: 'txt', title: '', author: '', lang: '', sections, styles: {} }, cover: null };
}

function slug(text, used) {
  let base = String(text).toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-') || 'section';
  let id = base;
  let n = 1;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

export function parseMarkdown(bytes) {
  const source = decodeText(bytes).replace(/\r\n?/g, '\n');
  // 앞머리(front matter) 제거
  const body = source.replace(/^---\n[\s\S]*?\n---\n/, '');
  const html = marked.parse(body, { gfm: true, breaks: true, async: false });
  const hd = newHtmlDoc();
  const root = hd.createElement('div');
  root.innerHTML = purify(html);
  const used = new Set();
  for (const hEl of root.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (!hEl.id) hEl.id = slug(hEl.textContent, used); else used.add(hEl.id);
  }
  for (const img of [...root.querySelectorAll('img')]) {
    const alt = img.getAttribute('alt');
    const span = hd.createElement('span');
    span.className = 'g-img-alt';
    span.textContent = alt ? `[그림: ${alt}]` : '[그림]';
    img.replaceWith(span);
  }
  for (const table of [...root.querySelectorAll('table')]) {
    if (table.parentElement?.classList.contains('g-table')) continue;
    const wrap = hd.createElement('div');
    wrap.className = 'g-table';
    table.replaceWith(wrap);
    wrap.append(table);
  }
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) a.setAttribute('href', `#g:?:${decodeURIComponent(href.slice(1))}`);
    else if (/^(https?:|mailto:)/i.test(href)) a.setAttribute('data-ext', '1');
    else a.removeAttribute('href');
  }
  const title = (root.querySelector('h1')?.textContent || '').trim();
  const parts = splitIntoSections(root);
  const boxes = parts.map((p) => { const b = hd.createElement('div'); b.innerHTML = p; return b; });
  const idSection = new Map();
  boxes.forEach((b, s) => b.querySelectorAll('[id]').forEach((el) => { if (!idSection.has(el.id)) idSection.set(el.id, s); }));
  const sections = boxes.map((b) => {
    for (const a of b.querySelectorAll('a[href^="#g:?:"]')) {
      const id = a.getAttribute('href').slice(5);
      const s = idSection.get(id);
      if (s == null) a.removeAttribute('href'); else a.setAttribute('href', `#g:${s}:${id}`);
    }
    return { html: purify(b.innerHTML), bodyClass: 'md', styles: [] };
  });
  return { book: { format: 'md', title, author: '', lang: '', sections, styles: {} }, cover: null };
}
