// PDF → 전자책: 쪽 그림을 그대로 보여 주는 대신 글을 다시 짜서 EPUB처럼 읽게 한다(2026-11-09 사용자 요청).
// 글 뽑기(단 순서·머리말 빼기·줄 잇기·표)는 DRE와 같은 코드(../pdfx), 여기서는 그 결과를 제목·문단·그림·표·각주가 있는 책으로 엮는다.
// 그림은 자리만 적어 두고(book.figs) 읽을 때 원본 쪽에서 오려 그린다(reader/pdffigs.js).
import { pdfjs, openPdf, closePdf, pdfOutline } from '../pdfdoc.js';
import { pageFromPdfjs, analyzePage, assemble, MARK } from '../pdfx/pdflayout.js';
import { resolveSoftBreaks, isListStart } from '../pdfx/joiner.js';
import { loadDictionary, unloadDictionary } from '../pdfx/dict.js';
import { purify } from './common.js';

const SOFT_SPACE = String.fromCharCode(0xE010);
const SOFT_NONE = String.fromCharCode(0xE011);
const { supOpen, supClose, boldOpen, boldClose, italOpen, italClose } = MARK;

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const noSpace = (s) => s.replace(/\s+/g, '');
const median = (arr) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// 글꼴 진짜 이름(굵기·기울임·글꼴별 글자 바로잡기에 쓴다)
function fontNamesOf(page, tc) {
  const out = {};
  for (const k of Object.keys(tc.styles || {})) {
    try {
      if (!page.commonObjs.has(k)) continue;
      const f = page.commonObjs.get(k);
      if (f && f.name) out[k] = String(f.name);
    } catch { /* 없으면 그만 */ }
  }
  return out;
}

// PDF 를 쪽마다 분석해 책으로
export async function parsePdfBook(blob, { onProgress } = {}) {
  await loadDictionary();
  const lib = await pdfjs();
  const pdf = await openPdf(blob, { fontExtraProperties: true });
  try {
    const n = pdf.numPages;
    const analyzed = [];
    let seen = 0;
    let junk = 0; // 글꼴에 글자표가 없어 깨진 글자(사용 영역·대체 문자)
    for (let i = 1; i <= n; i++) {
      const page = await pdf.getPage(i);
      try {
        const viewport = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        for (const it of tc.items) for (const ch of it.str || '') {
          const c = ch.codePointAt(0);
          if (c <= 32) continue;
          seen++;
          if (c === 0xFFFD || (c >= 0xE000 && c <= 0xF8FF)) junk++;
        }
        let ops = null;
        try { ops = await page.getOperatorList(); } catch { ops = null; }
        const data = pageFromPdfjs(tc, ops, viewport, lib.OPS, fontNamesOf(page, tc));
        const a = analyzePage(data);
        a.spaces = data.spaces;
        analyzed.push(a);
      } finally {
        page.cleanup();
      }
      onProgress?.((i / n) * 0.92);
      if (i % 3 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    const textPages = analyzed.filter((a) => a.chars >= 30).length;
    const total = analyzed.reduce((sum, a) => sum + a.chars, 0);
    // 글자가 거의 없는 PDF(스캔본 등)는 다시 짤 글이 없다 — 원본 쪽 보기로
    if (textPages < Math.max(1, n * 0.5) || total < 200 || junk > seen * 0.15) {
      return { book: { format: 'pdf', title: '', author: '', lang: '', sections: [{ html: '', bodyClass: 'pdf', styles: [] }], styles: {}, figs: {}, pages: n, reflow: false }, cover: null };
    }
    const { blocks } = assemble(analyzed);
    const holder = { blocks };
    resolveSoftBreaks(holder);
    const outline = await pdfOutline(pdf).catch(() => []);
    const wide = analyzed.filter((a) => a.w > a.h * 1.15).length;
    // 슬라이드처럼 가로로 눕힌 쪽에 글이 적은 문서는 쪽 모양 자체가 내용이다 — 처음엔 원본 쪽으로(메뉴에서 바꿀 수 있다)
    const slideLike = wide >= n * 0.7 && total / n < 700;
    const book = buildBook(holder.blocks, analyzed, outline);
    book.pages = n;
    book.reflow = true;
    book.preferOriginal = slideLike;
    onProgress?.(1);
    return { book, cover: null };
  } finally {
    closePdf(pdf);
    unloadDictionary();
  }
}

// ── 글자 꾸밈 표시 → 글 조각 ──
function richTokens(str, pg) {
  const out = [];
  let cur = '';
  let sup = false, b = false, i = false;
  const push = () => { if (cur) { out.push({ t: cur, sup, b, i, pg }); cur = ''; } };
  for (const ch of str) {
    if (ch === supOpen) { push(); sup = true; }
    else if (ch === supClose) { push(); sup = false; }
    else if (ch === boldOpen) { push(); b = true; }
    else if (ch === boldClose) { push(); b = false; }
    else if (ch === italOpen) { push(); i = true; }
    else if (ch === italClose) { push(); i = false; }
    else cur += ch;
  }
  push();
  return out;
}

// 화면에 못 그리는 글자(사용 영역 글자)·폭 없는 빈칸을 뺀다
function cleanText(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === SOFT_SPACE) out += ' ';
    else if (ch === SOFT_NONE || c === 0x200B || c === 0xFEFF || c === 0xAD) continue;
    else if (c >= 0xE000 && c <= 0xF8FF) continue;
    else if (ch === '\t') out += '  ';
    else out += ch;
  }
  return out;
}

// 문단 → 글 조각 목록(줄 잇기·쪽 표시까지)
function paraTokens(b) {
  const toks = [];
  b.segs.forEach((seg, i) => {
    if (i > 0) {
      const j = b.joins[i - 1];
      if (j === 'S') toks.push({ sp: true });
      else if (j === 'H') toks.push({ br: true });
    }
    if (seg.pg != null) toks.push({ page: seg.pg });
    toks.push(...richTokens(seg.rich ?? seg.s, seg.pg));
  });
  return toks;
}

function plainOf(b) {
  let out = '';
  b.segs.forEach((seg, i) => {
    if (i > 0 && b.joins[i - 1] === 'S') out += ' ';
    if (i > 0 && b.joins[i - 1] === 'H') out += ' ';
    out += seg.s;
  });
  return cleanText(out).trim();
}

const NOTE_LABEL = /^\s*(\(?\d{1,3}\)|\d{1,3}[.\s]|[*†‡§※]\s*\d*|주\s*\d+\)?|\[\d{1,3}\])\s*/;
const CAPTION = /^\s*[<〈《【[(]?\s*(?:표|그림|도표|사진|차트|그래프|figure|fig\.?|table|chart|exhibit)\s*[\dⅠ-Ⅻ<〈-]/i;
const NUMBERED_HEAD = /^\s*(?:제\s*[\d一二三四五六七八九十]+\s*[장절편부관항]|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+[.\s]|[IVX]{1,5}\.\s|\d{1,2}(?:\.\d{1,2}){0,3}\.?\s|[가-하]\.\s|chapter\s+\d|part\s+\d|section\s+\d)/i;
const LEADERS = /\s*[.·…‥・ㆍ]{4,}\s*(\d{1,4})\s*$/;
// 본문에 그냥 글자로 붙은 각주 번호('수집31하였다') — 그 쪽에 같은 번호의 각주가 있을 때만
const INLINE_REF = /([가-힣a-zA-Z)\]”’"'.,])(\d{1,3})(\)?)(?=[가-힣\s.,;:)\]”’"']|$)/g;
const COUNTER = /^[년월일개명건쪽면장절조항호회차번대세원배분초시]/;
const DOTS = /[.·…‥・ㆍ]{6,}/g; // 목차의 긴 점선
const SPACED_WORDS = new Set(['ABSTRACT', 'KEYWORD', 'KEYWORDS', 'CONTENTS', 'REFERENCES', 'INTRODUCTION', 'CONCLUSION', 'SUMMARY']);

// ── 책 엮기 ──
function buildBook(blocks, analyzed, outline) {
  // ① 각주를 따로 모으고, 쪽·그림을 넘어 이어지는 문단을 하나로
  const body = [];
  const notes = new Map();
  const noteList = [];
  let lastNote = null;
  let noteSeq = 0;
  for (const b of blocks) {
    if (b.t === 'p') {
      if (b.kind === 'hf' || b.kind === 'rot') continue;
      if (b.kind === 'fn') {
        const pg = b.segs[0].pg;
        if (b.fnFirst || !lastNote) {
          const label = NOTE_LABEL.exec(b.segs[0].s)?.[1]?.trim() || '';
          lastNote = { id: `fn-${pg}-${++noteSeq}`, pg, label, digits: label.replace(/\D/g, ''), parts: [b] };
          if (!notes.has(pg)) notes.set(pg, []);
          notes.get(pg).push(lastNote);
          noteList.push(lastNote);
        } else {
          lastNote.parts.push(b);
        }
        continue;
      }
      if (b.cont) {
        let A = null;
        for (let k = body.length - 1; k >= 0; k--) if (body[k].t === 'p') { A = body[k]; break; }
        if (A) {
          let code = b.contJoin || 'S';
          if (code === 'D') {
            const last = A.segs[A.segs.length - 1];
            last.s = last.s.replace(/-$/, '');
            if (last.rich) last.rich = last.rich.replace(new RegExp(`-([${supClose}${boldClose}${italClose}]*)$`), '$1');
            code = 'N';
          }
          A.joins += code + b.joins;
          A.segs.push(...b.segs);
          A.m = { ...A.m, lines: A.m.lines + b.m.lines, chars: A.m.chars + b.m.chars };
          continue;
        }
      }
    }
    body.push(b);
  }

  // ② 본문 글자 크기 — 글자 수로 가중한 가운데값
  const sizes = [];
  for (const b of body) if (b.t === 'p' && b.m) for (let i = 0; i < Math.min(40, b.m.chars); i++) sizes.push(Math.round(b.m.size * 4) / 4);
  const bodySize = median(sizes) || 10;

  // ③ 제목 가리기
  const heads = [];
  for (const b of body) {
    if (b.t !== 'p' || !b.m || b.kind === 'tab' || b.kind === 'note') continue;
    const text = plainOf(b);
    if (!text || text.length > 110 || b.m.lines > 3) continue;
    if (CAPTION.test(text)) { b.caption = true; continue; }
    if (LEADERS.test(text)) continue;
    if (isListStart(text) && !NUMBERED_HEAD.test(text)) continue;
    const r = b.m.size / bodySize;
    const ends = /[.!?。…,;:]$|[다요]\.?$/.test(text) && text.length > 25;
    const numbered = NUMBERED_HEAD.test(text);
    let is = false;
    if (r >= 1.16 && !ends) is = true;
    else if (r >= 1.04 && b.m.bold >= 0.8 && !ends) is = true;
    else if (b.m.bold >= 0.9 && numbered && !ends && text.length <= 70 && r >= 0.96) is = true;
    if (is) { b.isHead = true; heads.push(b); }
  }
  // 제목 단계: 글자 크기(비슷하면 같은 단계) 큰 것부터 h1·h2·h3
  const levels = [];
  for (const b of heads) {
    const sz = b.m.size;
    if (!levels.some((v) => Math.abs(v - sz) <= sz * 0.05)) levels.push(sz);
  }
  levels.sort((a, b) => b - a);
  const levelOf = (sz) => Math.min(4, levels.findIndex((v) => Math.abs(v - sz) <= sz * 0.05) + 1) || 2;
  for (const b of heads) b.head = levelOf(b.m.size);

  // 첫 쪽 본문이 시작되기 전의 큰 글은 문서 제목 줄이다(목차에 넣지 않는다)
  for (const b of body) {
    if (b.t !== 'p') continue;
    if (b.segs[0].pg > 1) break;
    if (b.isHead) b.isTitle = true;
    else if (plainOf(b).length >= 60) break;
  }

  // ④ PDF 책갈피(목차)와 맞추기
  const tocRaw = [];
  const byPage = new Map();
  body.forEach((b) => {
    const pg = b.t === 'p' ? b.segs[0].pg : b.pg;
    if (!byPage.has(pg)) byPage.set(pg, []);
    byPage.get(pg).push(b);
  });
  let tocSeq = 0;
  for (const e of outline) {
    const want = noSpace(e.title);
    let hit = null;
    for (const b of byPage.get(e.page) || []) {
      if (b.t !== 'p') continue;
      const t = noSpace(plainOf(b));
      if (t && (t === want || (want.length >= 4 && (t.startsWith(want) || want.startsWith(t))))) { hit = b; break; }
    }
    if (hit) {
      hit.isHead = true;
      if (!hit.head) hit.head = Math.min(4, e.level);
      hit.tocId = hit.tocId || `toc-${++tocSeq}`;
      hit.isTitle = false;
      tocRaw.push({ title: e.title, level: Math.min(6, e.level), id: hit.tocId });
    } else {
      tocRaw.push({ title: e.title, level: Math.min(6, e.level), id: `pg-${e.page - 1}` });
    }
  }

  // ⑤ HTML 로
  const seenPage = new Set();
  const pageMark = (pg) => {
    if (pg == null || seenPage.has(pg)) return '';
    seenPage.add(pg);
    return `<a id="pg-${pg - 1}"></a>`;
  };
  const figs = {};
  const figSeq = new Map();
  const noteFor = (pg, digits) => {
    if (!digits) return null;
    for (const p of [pg, pg - 1, pg + 1]) {
      const n = (notes.get(p) || []).find((x) => x.digits === digits && !x.used);
      if (n) return n;
    }
    return null;
  };

  const inlineRefs = (raw, pg, usedNotes) => {
    if (pg == null || !notes.has(pg)) return esc(raw);
    let out = '';
    let last = 0;
    for (const m of raw.matchAll(INLINE_REF)) {
      const at = m.index + m[1].length;
      if (m[1] === '제' || COUNTER.test(raw.slice(at + m[2].length + m[3].length))) continue;
      const note = (notes.get(pg) || []).find((x) => x.digits === m[2] && !x.used);
      if (!note) continue;
      note.used = true;
      usedNotes.push(note);
      out += `${esc(raw.slice(last, at))}<sup><a class="g-noteref" data-epub-type="noteref" href="#g:?:${note.id}" id="${note.id}r">${m[2]}</a></sup>`;
      last = at + m[2].length + m[3].length;
    }
    return out + esc(raw.slice(last));
  };

  // 글 조각 → HTML. plainStyle: 꾸밈을 안 넣는다(제목)
  const tokensHtml = (toks, { plainStyle = false, usedNotes = null } = {}) => {
    // 같은 꾸밈끼리 잇기(사이 빈칸은 앞뒤가 같으면 함께)
    const runs = [];
    for (const k of toks) {
      if (k.sp) { const L = runs[runs.length - 1]; if (L && !L.br && !L.page) L.t += ' '; else runs.push({ t: ' ' }); continue; }
      if (k.br || k.page != null && k.t == null) { runs.push(k); continue; }
      const L = runs[runs.length - 1];
      if (L && L.t != null && !L.page && !L.br && L.sup === k.sup && L.b === k.b && L.i === k.i) L.t += k.t;
      else if (L && L.t != null && !L.page && !L.br && L.sup === undefined && !k.sup) { L.t += k.t; L.b = k.b; L.i = k.i; L.sup = false; }
      else runs.push({ ...k });
    }
    let html = '';
    for (const r of runs) {
      if (r.br) { html += '<br>'; continue; }
      if (r.page != null && r.t == null) { html += pageMark(r.page); continue; }
      const raw = cleanText(r.t).replace(DOTS, ' … ');
      if (!raw) continue;
      let s = r.sup || !usedNotes ? esc(raw) : inlineRefs(raw, r.pg, usedNotes);
      if (r.sup) {
        const note = usedNotes ? noteFor(r.pg, raw.replace(/\D/g, '')) : null;
        if (note) {
          note.used = true;
          usedNotes.push(note);
          s = `<sup><a class="g-noteref" data-epub-type="noteref" href="#g:?:${note.id}" id="${note.id}r">${s}</a></sup>`;
        } else s = `<sup>${s}</sup>`;
      } else if (!plainStyle) {
        if (r.i) s = `<i>${s}</i>`;
        if (r.b) s = `<b>${s}</b>`;
      }
      html += s;
    }
    return html;
  };

  const items = [];
  // 표의 자리도 그림처럼 적어 둔다 — 화면에 안 들어갈 때 대신 보이고, 누르면 크게 본다
  const figKey = (pg, rect, prefix) => {
    const n = (figSeq.get(pg) || 0) + 1;
    figSeq.set(pg, n);
    const key = `${prefix}${pg - 1}_${n}`;
    figs[key] = { p: pg - 1, x0: +Math.max(0, rect.x0 - 3).toFixed(1), y0: +Math.max(0, rect.y0 - 3).toFixed(1), x1: +(rect.x1 + 3).toFixed(1), y1: +(rect.y1 + 3).toFixed(1) };
    return key;
  };
  const NUM_CELL = /^[-+−▲▼△▽(]*[\d][\d,.]*[%)]*$/;
  const MANY_NUMS = /^[-+−▲▼△▽(]*\d[\d,.]*[%)]*(?:\s+[-+−▲▼△▽(]*\d[\d,.]*[%)]*){2,}$/;
  const tableHtml = (b) => {
    const key = b.rect ? figKey(b.pg, b.rect, 't') : '';
    // 칸 구조를 믿기 어려운 표(행 머리 칸이 표 밖이거나, 한 칸에 여러 행의 숫자가 뭉친 표)는 원본 쪽의 그림으로 보여 준다
    const merged = b.rows.flat().filter((c) => c && MANY_NUMS.test(cleanText(c.s).trim())).length;
    const asImage = key && (b.side || merged >= 2);
    let out = `<div class="g-table${asImage ? ' g-table-img g-table-fixed' : ''}"${key ? ` data-fig="${key}"` : ''}>`;
    if (asImage) {
      const f = figs[key];
      out += `<img data-gui="" data-g-src="${key}" width="${Math.round((f.x1 - f.x0) * 1.6)}" height="${Math.round((f.y1 - f.y0) * 1.6)}" alt="">`;
    }
    out += '<table>';
    if (b.side) out += `<tr><td>${esc(cleanText(b.side))}</td></tr>`;
    for (const row of b.rows) {
      if (!row.some(Boolean)) continue;
      out += '<tr>';
      for (const c of row) {
        if (!c) continue;
        const attrs = `${c.cs > 1 ? ` colspan="${c.cs}"` : ''}${c.rs > 1 ? ` rowspan="${c.rs}"` : ''}`;
        const plain = cleanText(c.s).trim();
        const num = NUM_CELL.test(plain) ? ' class="g-num"' : '';
        const text = esc(plain).replace(/\n/g, '<br>');
        out += `<td${attrs}${num}>${text}</td>`;
      }
      out += '</tr>';
    }
    return `${out}</table></div>`;
  };
  // 선 없는 표(칸이 띄어진 줄들) → 표로
  const tabGroupHtml = (group) => {
    const size = group[0].m?.size || 10;
    const xs = group.flatMap((b) => b.tabs || []).sort((a, b) => a - b);
    const cols = [];
    for (const x of xs) {
      const L = cols[cols.length - 1];
      if (L != null && x - L.max <= size * 1.5) L.max = x; else cols.push({ min: x, max: x });
    }
    const rect = { x0: Math.min(...group.map((b) => b.m.x0)), y0: Math.min(...group.map((b) => b.m.top)), x1: Math.max(...group.map((b) => b.m.x1)), y1: Math.max(...group.map((b) => b.m.bot)) };
    const samePage = group.every((b) => b.segs[0].pg === group[0].segs[0].pg);
    const key = samePage ? figKey(group[0].segs[0].pg, rect, 't') : '';
    let out = `<div class="g-table"${key ? ` data-fig="${key}"` : ''}><table class="g-plain">`;
    for (const b of group) {
      const cells = (b.segs[0].rich ?? b.segs[0].s).split('\t');
      const row = new Array(cols.length).fill(null);
      cells.forEach((c, i) => {
        const x = b.tabs?.[i] ?? 0;
        let k = cols.findIndex((col) => x >= col.min - size && x <= col.max + size);
        if (k < 0) k = 0;
        row[k] = row[k] == null ? c : `${row[k]} ${c}`;
      });
      out += '<tr>';
      for (const c of row) {
        const num = c != null && NUM_CELL.test(cleanText(c).trim()) ? ' class="g-num"' : '';
        out += `<td${num}>${c == null ? '' : tokensHtml(richTokens(c, b.segs[0].pg), {})}</td>`;
      }
      out += '</tr>';
    }
    return `${out}</table></div>`;
  };

  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    if (b.t === 'fig') {
      const n = (figSeq.get(b.pg) || 0) + 1;
      figSeq.set(b.pg, n);
      const key = `f${b.pg - 1}_${n}`;
      const g = b.fig;
      figs[key] = { p: b.pg - 1, x0: +g.x0.toFixed(1), y0: +g.y0.toFixed(1), x1: +g.x1.toFixed(1), y1: +g.y1.toFixed(1) };
      const w = Math.round((g.x1 - g.x0) * 1.6), h = Math.round((g.y1 - g.y0) * 1.6);
      items.push({ html: `<figure class="g-fig${g.full ? ' g-fig-full' : ''}">${pageMark(b.pg)}<img data-g-src="${key}" width="${w}" height="${h}" alt=""></figure>`, chars: 400, head: 0, notes: [] });
      continue;
    }
    if (b.t === 'tbl') {
      const mark = pageMark(b.pg);
      let html = tableHtml(b);
      if (mark) html = mark + html;
      const chars = b.rows.reduce((n, r) => n + r.reduce((m, c) => m + (c ? c.s.length : 0), 0), 0);
      items.push({ html, chars, head: 0, notes: [] });
      continue;
    }
    if (b.t !== 'p') continue;
    if (b.kind === 'tab' && !b.isHead) {
      const group = [b];
      while (i + 1 < body.length && body[i + 1].t === 'p' && body[i + 1].kind === 'tab') group.push(body[++i]);
      const mark = pageMark(b.segs[0].pg);
      if (group.length >= 2) {
        items.push({ html: mark + tabGroupHtml(group), chars: group.reduce((n, x) => n + plainOf(x).length, 0), head: 0, notes: [] });
        continue;
      }
      const text = plainOf(b);
      const m = LEADERS.exec(text);
      const html = m ? esc(text.slice(0, m.index)) + `<span class="g-toc-page">${m[1]}</span>` : tokensHtml(paraTokens(b).filter((t) => t.page == null), {});
      items.push({ html: `<p class="${m ? 'g-tocline' : 'g-left'}">${mark}${html}</p>`, chars: text.length, head: 0, notes: [] });
      continue;
    }
    const used = [];
    const text = plainOf(b);
    if (b.isTitle) {
      items.push({ html: `<p class="g-title g-title-${Math.max(1, Math.min(3, b.head || 2))}">${tokensHtml(paraTokens(b), { plainStyle: true })}</p>`, chars: text.length, head: 0, notes: [] });
      continue;
    }
    if (b.isHead) {
      const lvl = Math.max(1, Math.min(4, b.head || 2));
      if (/^[A-Z ]{6,}$/.test(text) && SPACED_WORDS.has(noSpace(text))) {
        const idA = b.tocId ? ` id="${b.tocId}"` : '';
        items.push({ html: `<h${lvl}${idA}>${pageMark(b.segs[0].pg)}${noSpace(text)}</h${lvl}>`, chars: text.length, head: lvl, notes: [] });
        continue;
      }
      const idAttr = b.tocId ? ` id="${b.tocId}"` : '';
      items.push({ html: `<h${lvl}${idAttr}>${tokensHtml(paraTokens(b), { plainStyle: true, usedNotes: used })}</h${lvl}>`, chars: text.length, head: lvl, notes: used });
      continue;
    }
    // 목차 줄(점선 + 쪽 번호)
    const lead = LEADERS.exec(text);
    if (lead) {
      items.push({ html: `<p class="g-tocline">${pageMark(b.segs[0].pg)}${esc(text.slice(0, lead.index))}<span class="g-toc-page">${lead[1]}</span></p>`, chars: text.length, head: 0, notes: [] });
      continue;
    }
    const cls = [];
    if (b.caption) cls.push('g-cap');
    else if (b.kind === 'center') cls.push('g-center');
    else if (b.kind === 'note') cls.push('g-small');
    if (isListStart(text)) cls.push('g-li');
    const indent = b.m ? Math.round(Math.max(0, b.m.indent) / (bodySize * 1.6)) : 0;
    if (indent > 0 && !b.caption && b.kind !== 'center') cls.push(`g-in${Math.min(3, indent)}`);
    const clsAttr = cls.length ? ` class="${cls.join(' ')}"` : '';
    const inner = tokensHtml(paraTokens(b), { usedNotes: used });
    if (!inner.replace(/<a id="[^"]*"><\/a>/g, '').trim()) continue;
    items.push({ html: `<p${clsAttr}>${inner}</p>`, chars: text.length, head: 0, notes: used });
  }

  // ⑥ 구획으로 나누기(큰 제목에서, 너무 길면 문단에서)
  const groups = [];
  let cur = [];
  let chars = 0;
  for (const it of items) {
    if (cur.length && ((it.head && it.head <= 2 && chars >= 3000) || chars >= 24000)) { groups.push(cur); cur = []; chars = 0; }
    cur.push(it);
    chars += it.chars;
  }
  if (cur.length || !groups.length) groups.push(cur);

  // 본문에서 번호를 못 찾은 각주는 그 쪽 글이 든 구획 끝에
  const noteSection = new Map();
  groups.forEach((g, s) => { for (const it of g) for (const n of it.notes) noteSection.set(n.id, s); });
  const pageSection = new Map();
  groups.forEach((g, s) => { for (const it of g) for (const m of it.html.matchAll(/id="pg-(\d+)"/g)) pageSection.set(Number(m[1]) + 1, s); });
  const perSection = groups.map(() => []);
  for (const n of noteList) {
    let s = noteSection.get(n.id);
    if (s == null) {
      for (const p of [n.pg, n.pg - 1, n.pg + 1]) if (pageSection.has(p)) { s = pageSection.get(p); break; }
    }
    if (s == null) s = groups.length - 1;
    noteSection.set(n.id, s);
    perSection[s].push(n);
  }
  const noteHtml = (n) => {
    const parts = n.parts.map((b, k) => {
      const toks = paraTokens(b).filter((t) => t.page == null);
      // 맨 앞 번호 표시는 빼고 앞에 고른 모양으로
      if (k === 0 && n.label) stripLabel(toks);
      return `<p>${k === 0 && n.label ? `<span class="g-note-num">${esc(n.label.replace(/[()[\].\s]/g, ''))}</span> ` : ''}${tokensHtml(toks, {})}</p>`;
    }).join('');
    return `<aside id="${n.id}" class="g-note-el" data-epub-type="footnote">${parts}</aside>`;
  };
  const sections = groups.map((g, s) => {
    let html = g.map((it) => it.html).join('');
    if (perSection[s].length) html += `<section class="g-footnotes" data-epub-type="footnotes">${perSection[s].map(noteHtml).join('')}</section>`;
    html = html.replace(/#g:\?:(fn-\d+-\d+)/g, (m, id) => `#g:${noteSection.get(id) ?? s}:${id}`);
    return { html: purify(html), bodyClass: 'pdf', styles: [] };
  });

  // 목차: 위치 id 가 든 구획을 찾아 둔다
  const idSection = new Map();
  sections.forEach((sec, s) => { for (const m of sec.html.matchAll(/id="((?:toc|pg)-[\d]+)"/g)) if (!idSection.has(m[1])) idSection.set(m[1], s); });
  const toc = [];
  for (const e of tocRaw) {
    let id = e.id;
    let s = idSection.get(id);
    if (s == null && id.startsWith('pg-')) {
      // 글이 없는 쪽이면 그 뒤 가장 가까운 쪽으로
      for (let p = Number(id.slice(3)) + 1; p < analyzed.length && s == null; p++) { id = `pg-${p}`; s = idSection.get(id); }
    }
    if (s != null) toc.push({ title: e.title, level: e.level, s, frag: id });
  }
  return { format: 'pdf', title: '', author: '', lang: '', sections, styles: {}, figs, tocRaw: toc.length >= 2 ? toc : null };
}

// 각주 맨 앞의 번호 글자를 글 조각에서 뺀다
function stripLabel(toks) {
  let joined = '';
  for (const t of toks) if (t.t != null) joined += t.t;
  const m = NOTE_LABEL.exec(joined);
  if (!m) return;
  let cut = m[0].length;
  for (const t of toks) {
    if (t.t == null || cut <= 0) continue;
    if (t.t.length <= cut) { cut -= t.t.length; t.t = ''; } else { t.t = t.t.slice(cut); cut = 0; }
  }
}
