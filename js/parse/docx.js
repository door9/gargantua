// DOCX → HTML. 제목·목록·표·그림·각주·링크·책갈피를 살린다.
import { unzipSync } from '../../vendor/fflate.mjs';
import { purify, splitIntoSections, newHtmlDoc, joinPath, mimeOf } from './common.js';
import { ParseError } from './epub.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function xml(files, path) {
  const bytes = files[path];
  if (!bytes) return null;
  const doc = new DOMParser().parseFromString(new TextDecoder('utf-8').decode(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  return doc;
}
const kids = (el, name) => (el ? [...el.children].filter((c) => !name || c.localName === name) : []);
const kid = (el, name) => (el ? [...el.children].find((c) => c.localName === name) || null : null);
const wattr = (el, name) => (el ? (el.getAttributeNS(W, name) ?? el.getAttribute(`w:${name}`) ?? el.getAttribute(name)) : null);
const deep = (el, name) => (el ? [...el.getElementsByTagNameNS('*', name)] : []);

export function unzipDocx(bytes) {
  try {
    return unzipSync(bytes, { filter: (f) => !f.name.endsWith('/') });
  } catch {
    throw new ParseError('DOCX 압축을 풀지 못했습니다. 파일이 손상되었을 수 있습니다.');
  }
}

export function docxResources(files) {
  const res = new Map();
  for (const name of Object.keys(files)) {
    if (/^word\/media\//i.test(name)) res.set(name, new Blob([files[name]], { type: mimeOf(name, 'application/octet-stream') }));
  }
  return res;
}

function readRels(files, path) {
  const doc = xml(files, path);
  const map = new Map();
  if (!doc) return map;
  for (const r of deep(doc, 'Relationship')) {
    map.set(r.getAttribute('Id'), { target: r.getAttribute('Target') || '', mode: r.getAttribute('TargetMode') || '', type: r.getAttribute('Type') || '' });
  }
  return map;
}

function readStyles(files) {
  const doc = xml(files, 'word/styles.xml');
  const styles = new Map();
  if (!doc) return styles;
  for (const st of deep(doc, 'style')) {
    const id = wattr(st, 'styleId');
    if (!id) continue;
    const name = wattr(kid(st, 'name'), 'val') || id;
    const basedOn = wattr(kid(st, 'basedOn'), 'val');
    const pPr = kid(st, 'pPr');
    const outline = wattr(kid(pPr, 'outlineLvl'), 'val');
    const rPr = kid(st, 'rPr');
    styles.set(id, {
      id, name, basedOn, type: wattr(st, 'type'),
      outline: outline != null ? Number(outline) : null,
      bold: !!kid(rPr, 'b') && wattr(kid(rPr, 'b'), 'val') !== '0' && wattr(kid(rPr, 'b'), 'val') !== 'false',
      italic: !!kid(rPr, 'i') && wattr(kid(rPr, 'i'), 'val') !== '0' && wattr(kid(rPr, 'i'), 'val') !== 'false',
      numId: wattr(kid(kid(pPr, 'numPr'), 'numId'), 'val'),
    });
  }
  return styles;
}

function headingFromStyle(styles, styleId) {
  let cur = styles.get(styleId);
  for (let guard = 0; cur && guard < 10; guard++) {
    if (cur.outline != null && cur.outline >= 0 && cur.outline < 6) return cur.outline + 1;
    const m = /(?:heading|제목)\s*([1-6])/i.exec(`${cur.id} ${cur.name}`);
    if (m) return Number(m[1]);
    if (/^title$|^표제$/i.test(cur.name) || /^Title$/.test(cur.id)) return 1;
    cur = cur.basedOn ? styles.get(cur.basedOn) : null;
  }
  return null;
}

function readNumbering(files) {
  const doc = xml(files, 'word/numbering.xml');
  const abstract = new Map();
  const nums = new Map();
  if (!doc) return { listType: () => 'ul' };
  for (const an of deep(doc, 'abstractNum')) {
    const levels = new Map();
    for (const lvl of kids(an, 'lvl')) levels.set(Number(wattr(lvl, 'ilvl') || 0), wattr(kid(lvl, 'numFmt'), 'val') || 'decimal');
    abstract.set(wattr(an, 'abstractNumId'), levels);
  }
  for (const num of deep(doc, 'num')) nums.set(wattr(num, 'numId'), wattr(kid(num, 'abstractNumId'), 'val'));
  return {
    listType(numId, ilvl) {
      const levels = abstract.get(nums.get(numId));
      const fmt = levels?.get(ilvl) || 'bullet';
      return fmt === 'bullet' || fmt === 'none' ? 'ul' : 'ol';
    },
  };
}

export async function parseDocx(bytes) {
  const files = unzipDocx(bytes);
  const docXml = xml(files, 'word/document.xml');
  if (!docXml) throw new ParseError('올바른 Word 문서(DOCX)가 아닙니다.');
  const body = deep(docXml, 'body')[0];
  if (!body) throw new ParseError('DOCX 본문을 찾지 못했습니다.');

  const ctx = {
    hd: newHtmlDoc(),
    rels: readRels(files, 'word/_rels/document.xml.rels'),
    styles: readStyles(files),
    numbering: readNumbering(files),
    files,
    notes: [],
    noteOrder: new Map(),
    footnotes: new Map(),
    endnotes: new Map(),
  };
  loadNotes(ctx, 'word/footnotes.xml', 'footnote', ctx.footnotes, 'word/_rels/footnotes.xml.rels');
  loadNotes(ctx, 'word/endnotes.xml', 'endnote', ctx.endnotes, 'word/_rels/endnotes.xml.rels');

  const root = ctx.hd.createElement('div');
  convertBlocks(ctx, kids(body), root);

  if (ctx.notes.length) {
    const sec = ctx.hd.createElement('section');
    sec.className = 'g-footnotes';
    sec.setAttribute('data-epub-type', 'footnotes');
    const title = ctx.hd.createElement('h2');
    title.textContent = '주석';
    sec.append(title);
    for (const note of ctx.notes) {
      const aside = ctx.hd.createElement('aside');
      aside.id = note.id;
      aside.setAttribute('data-epub-type', 'footnote');
      aside.className = 'g-note-el';
      const back = ctx.hd.createElement('a');
      back.setAttribute('href', `#g:?:${note.refId}`);
      back.className = 'g-note-back';
      back.textContent = `${note.label}.`;
      const first = note.blocks.querySelector('p');
      if (first) first.prepend(back, ctx.hd.createTextNode(' ')); else aside.append(back);
      aside.append(...note.blocks.childNodes);
      sec.append(aside);
    }
    root.append(sec);
  }

  const title = (root.querySelector('h1')?.textContent || '').trim();
  const sectionsHtml = splitIntoSections(root);
  // 구획을 넘나드는 내부 링크(#g:?:이름) 풀기
  const idSection = new Map();
  const sectionRoots = sectionsHtml.map((html) => {
    const box = ctx.hd.createElement('div');
    box.innerHTML = html;
    return box;
  });
  sectionRoots.forEach((box, s) => box.querySelectorAll('[id]').forEach((el) => { if (!idSection.has(el.id)) idSection.set(el.id, s); }));
  const sections = sectionRoots.map((box) => {
    for (const a of box.querySelectorAll('a[href^="#g:?:"]')) {
      const id = a.getAttribute('href').slice(5);
      const s = idSection.get(id);
      if (s == null) a.removeAttribute('href'); else a.setAttribute('href', `#g:${s}:${id}`);
    }
    return { html: purify(box.innerHTML), bodyClass: 'docx', styles: [] };
  });
  return { book: { format: 'docx', title, author: '', lang: '', sections, styles: {} }, cover: null };
}

function loadNotes(ctx, path, kind, target, relsPath) {
  const doc = xml(ctx.files, path);
  if (!doc) return;
  const rels = readRels(ctx.files, relsPath);
  for (const note of deep(doc, kind)) {
    const type = wattr(note, 'type');
    if (type && type !== 'normal') continue;
    target.set(wattr(note, 'id'), { el: note, rels });
  }
}

function noteRef(ctx, kind, id) {
  const store = kind === 'footnote' ? ctx.footnotes : ctx.endnotes;
  const key = `${kind}:${id}`;
  let entry = ctx.noteOrder.get(key);
  if (!entry) {
    const src = store.get(id);
    const n = ctx.notes.length + 1;
    entry = { id: `${kind === 'footnote' ? 'fn' : 'en'}-${id}`, refId: `${kind === 'footnote' ? 'fnref' : 'enref'}-${id}`, label: String(n), blocks: ctx.hd.createElement('div') };
    ctx.noteOrder.set(key, entry);
    ctx.notes.push(entry);
    if (src) {
      const saved = ctx.rels;
      ctx.rels = src.rels.size ? src.rels : ctx.rels;
      convertBlocks(ctx, kids(src.el), entry.blocks, { inNote: true });
      ctx.rels = saved;
      // 각주 본문 맨 앞의 각주 번호 표시(빈 칸) 정리
    }
  }
  const sup = ctx.hd.createElement('sup');
  const a = ctx.hd.createElement('a');
  a.setAttribute('href', `#g:?:${entry.id}`);
  a.setAttribute('data-epub-type', 'noteref');
  a.className = 'g-noteref';
  a.id = entry.refId;
  a.textContent = entry.label;
  sup.append(a);
  return sup;
}

function convertBlocks(ctx, elements, parent, opts = {}) {
  const listStack = [];
  const closeLists = (toLevel = -1) => {
    while (listStack.length && listStack[listStack.length - 1].level > toLevel) listStack.pop();
  };
  for (const el of elements) {
    const name = el.localName;
    if (name === 'p') {
      const pPr = kid(el, 'pPr');
      const numPr = kid(pPr, 'numPr');
      let numId = wattr(kid(numPr, 'numId'), 'val');
      const ilvl = Number(wattr(kid(numPr, 'ilvl'), 'val') || 0);
      const styleId = wattr(kid(pPr, 'pStyle'), 'val');
      if (!numId && styleId) numId = ctx.styles.get(styleId)?.numId || null;
      const block = paragraph(ctx, el, opts);
      if (!block) {
        // 빈 문단은 목록을 끊지 않는다
        continue;
      }
      if (numId && numId !== '0' && block.tagName === 'P') {
        const type = ctx.numbering.listType(numId, ilvl);
        while (listStack.length && (listStack[listStack.length - 1].level > ilvl || (listStack[listStack.length - 1].level === ilvl && listStack[listStack.length - 1].type !== type))) listStack.pop();
        let top = listStack[listStack.length - 1];
        if (!top || top.level < ilvl) {
          const list = ctx.hd.createElement(type);
          if (top) {
            const lastLi = top.el.lastElementChild || top.el.appendChild(ctx.hd.createElement('li'));
            lastLi.append(list);
          } else parent.append(list);
          top = { level: ilvl, type, el: list };
          listStack.push(top);
        }
        const li = ctx.hd.createElement('li');
        li.append(...block.childNodes);
        for (const attr of ['id', 'style']) if (block.hasAttribute(attr)) li.setAttribute(attr, block.getAttribute(attr));
        top.el.append(li);
        continue;
      }
      closeLists();
      parent.append(block);
    } else if (name === 'tbl') {
      closeLists();
      parent.append(table(ctx, el, opts));
    } else if (name === 'sdt') {
      closeLists();
      convertBlocks(ctx, kids(kid(el, 'sdtContent')), parent, opts);
    } else if (name === 'customXml' || name === 'ins' || name === 'moveTo') {
      convertBlocks(ctx, kids(el), parent, opts);
    } else if (name === 'bookmarkStart') {
      const n = wattr(el, 'name');
      if (n && n !== '_GoBack') {
        const a = ctx.hd.createElement('a');
        a.id = n;
        parent.append(a);
      }
    }
  }
}

function paragraph(ctx, p, opts) {
  const pPr = kid(p, 'pPr');
  const styleId = wattr(kid(pPr, 'pStyle'), 'val');
  const directOutline = wattr(kid(pPr, 'outlineLvl'), 'val');
  let level = directOutline != null && Number(directOutline) < 6 ? Number(directOutline) + 1 : (styleId ? headingFromStyle(ctx.styles, styleId) : null);
  if (opts.inNote) level = null;
  const out = ctx.hd.createElement(level ? `h${Math.min(6, level)}` : 'p');
  const jc = wattr(kid(pPr, 'jc'), 'val');
  if (jc === 'center') out.setAttribute('style', 'text-align: center');
  else if (jc === 'right' || jc === 'end') out.setAttribute('style', 'text-align: right');
  const state = { field: null };
  inline(ctx, kids(p).filter((c) => c.localName !== 'pPr'), out, state, styleId);
  // 비었으면 버린다(그림·책갈피만 있으면 남긴다)
  const hasText = (out.textContent || '').trim().length > 0;
  if (!hasText && !out.querySelector('img, a[id]')) return null;
  if (!hasText && out.querySelector('a[id]') && !out.querySelector('img')) {
    // 책갈피만 있는 빈 문단 → 책갈피만 남기기 위해 빈 p 유지(글자 0)
  }
  return out;
}

function runProps(rPr, styleId, ctx) {
  const on = (name) => {
    const el = kid(rPr, name);
    if (!el) return null;
    const v = wattr(el, 'val');
    return !(v === '0' || v === 'false' || v === 'none');
  };
  const st = styleId ? ctx.styles.get(styleId) : null;
  const vert = wattr(kid(rPr, 'vertAlign'), 'val');
  return {
    b: on('b') ?? (st?.bold || false),
    i: on('i') ?? (st?.italic || false),
    u: !!kid(rPr, 'u') && wattr(kid(rPr, 'u'), 'val') !== 'none',
    s: on('strike') || on('dstrike'),
    sup: vert === 'superscript',
    sub: vert === 'subscript',
    hl: !!kid(rPr, 'highlight') && wattr(kid(rPr, 'highlight'), 'val') !== 'none',
  };
}

function wrapFormatting(ctx, node, props) {
  let cur = node;
  const wrap = (tag, cls) => {
    const el = ctx.hd.createElement(tag);
    if (cls) el.className = cls;
    el.append(cur);
    cur = el;
  };
  if (props.sup) wrap('sup');
  if (props.sub) wrap('sub');
  if (props.s) wrap('s');
  if (props.u) wrap('u');
  if (props.i) wrap('em');
  if (props.b) wrap('strong');
  if (props.hl) wrap('span', 'docx-mark');
  return cur;
}

function inline(ctx, nodes, parent, state, paraStyle) {
  for (const n of nodes) {
    const name = n.localName;
    if (name === 'r') run(ctx, n, parent, state, paraStyle);
    else if (name === 'hyperlink') {
      const rid = n.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || n.getAttribute('r:id');
      const anchor = wattr(n, 'anchor');
      const a = ctx.hd.createElement('a');
      if (anchor) a.setAttribute('href', `#g:?:${anchor}`);
      else if (rid && ctx.rels.get(rid)) {
        const target = ctx.rels.get(rid).target;
        if (/^(https?:|mailto:)/i.test(target)) { a.setAttribute('href', target); a.setAttribute('data-ext', '1'); }
      }
      inline(ctx, kids(n), a, state, paraStyle);
      parent.append(a);
    } else if (name === 'fldSimple') {
      const instr = wattr(n, 'instr') || '';
      const link = fieldLink(instr);
      if (link) {
        const a = ctx.hd.createElement('a');
        setLink(a, link);
        inline(ctx, kids(n), a, state, paraStyle);
        parent.append(a);
      } else inline(ctx, kids(n), parent, state, paraStyle);
    } else if (name === 'bookmarkStart') {
      const bm = wattr(n, 'name');
      if (bm && bm !== '_GoBack') {
        const a = ctx.hd.createElement('a');
        a.id = bm;
        parent.append(a);
      }
    } else if (name === 'ins' || name === 'moveTo' || name === 'smartTag' || name === 'customXml' || name === 'sdt' || name === 'sdtContent') {
      inline(ctx, name === 'sdt' ? kids(kid(n, 'sdtContent')) : kids(n), parent, state, paraStyle);
    }
    // del·moveFrom·proofErr 등은 건너뛴다
  }
}

function fieldLink(instr) {
  const m = /HYPERLINK\s+(?:\\l\s+)?"([^"]+)"/i.exec(instr) || /HYPERLINK\s+(\S+)/i.exec(instr);
  if (!m) return null;
  const isAnchor = /\\l/i.test(instr) && !/^https?:/i.test(m[1]);
  return isAnchor ? { anchor: m[1] } : { url: m[1] };
}
function setLink(a, link) {
  if (link.anchor) a.setAttribute('href', `#g:?:${link.anchor}`);
  else if (/^(https?:|mailto:)/i.test(link.url)) { a.setAttribute('href', link.url); a.setAttribute('data-ext', '1'); }
}

function run(ctx, r, parent, state, paraStyle) {
  const rPr = kid(r, 'rPr');
  const rStyle = wattr(kid(rPr, 'rStyle'), 'val');
  const props = runProps(rPr, rStyle, ctx);
  let text = '';
  const flush = () => {
    if (!text) return;
    const node = wrapFormatting(ctx, ctx.hd.createTextNode(text), props);
    (state.field?.el || parent).append(node);
    text = '';
  };
  for (const c of kids(r)) {
    switch (c.localName) {
      case 't': text += c.textContent; break;
      case 'tab': case 'ptab': text += ' '; break;
      case 'noBreakHyphen': text += '‑'; break;
      case 'softHyphen': break;
      case 'br': case 'cr': {
        if (wattr(c, 'type') === 'page' || wattr(c, 'type') === 'column') break;
        flush();
        (state.field?.el || parent).append(ctx.hd.createElement('br'));
        break;
      }
      case 'sym': {
        const ch = wattr(c, 'char');
        if (ch) {
          const code = parseInt(ch, 16);
          if (code >= 0xf000) text += '•'; else if (code) text += String.fromCodePoint(code);
        }
        break;
      }
      case 'fldChar': {
        const type = wattr(c, 'fldCharType');
        flush();
        if (type === 'begin') state.field = { instr: '', el: null, depth: (state.field?.depth || 0) + 1, outer: state.field };
        else if (type === 'separate' && state.field) {
          const link = fieldLink(state.field.instr);
          if (link) {
            const a = ctx.hd.createElement('a');
            setLink(a, link);
            (state.field.outer?.el || parent).append(a);
            state.field.el = a;
          }
        } else if (type === 'end' && state.field) state.field = state.field.outer || null;
        break;
      }
      case 'instrText': if (state.field) state.field.instr += c.textContent; break;
      case 'footnoteReference': flush(); (state.field?.el || parent).append(noteRef(ctx, 'footnote', wattr(c, 'id'))); break;
      case 'endnoteReference': flush(); (state.field?.el || parent).append(noteRef(ctx, 'endnote', wattr(c, 'id'))); break;
      case 'drawing': case 'pict': case 'object': {
        flush();
        for (const blip of [...deep(c, 'blip'), ...deep(c, 'imagedata')]) {
          const rid = blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed')
            || blip.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id')
            || blip.getAttribute('r:embed') || blip.getAttribute('r:id');
          const rel = rid && ctx.rels.get(rid);
          if (!rel || rel.mode === 'External') continue;
          const path = joinPath('word/document.xml', rel.target);
          if (!ctx.files[path]) continue;
          const img = ctx.hd.createElement('img');
          img.setAttribute('data-g-src', path);
          img.setAttribute('alt', deep(c, 'docPr')[0]?.getAttribute('descr') || '');
          img.setAttribute('loading', 'lazy');
          (state.field?.el || parent).append(img);
          break;
        }
        break;
      }
      default: break;
    }
  }
  flush();
}

function table(ctx, tbl, opts) {
  const t = ctx.hd.createElement('table');
  const rows = kids(tbl, 'tr');
  // 세로 병합(vMerge) 계산을 위해 격자 위치를 추적
  const grid = rows.map((tr) => {
    const cells = [];
    let col = Number(wattr(kid(kid(tr, 'trPr'), 'gridBefore'), 'val') || 0);
    for (const tc of kids(tr).flatMap((c) => (c.localName === 'sdt' ? kids(kid(c, 'sdtContent')) : [c])).filter((c) => c.localName === 'tc')) {
      const tcPr = kid(tc, 'tcPr');
      const span = Math.max(1, Number(wattr(kid(tcPr, 'gridSpan'), 'val') || 1));
      const vm = kid(tcPr, 'vMerge');
      const vMerge = vm ? (wattr(vm, 'val') === 'restart' ? 'restart' : 'continue') : null;
      cells.push({ tc, col, span, vMerge });
      col += span;
    }
    return { tr, cells, header: !!kid(kid(tr, 'trPr'), 'tblHeader') };
  });
  grid.forEach((row, ri) => {
    const trEl = ctx.hd.createElement('tr');
    for (const cell of row.cells) {
      if (cell.vMerge === 'continue') continue;
      let rowspan = 1;
      if (cell.vMerge === 'restart') {
        for (let k = ri + 1; k < grid.length; k++) {
          const below = grid[k].cells.find((c) => c.col === cell.col);
          if (below && below.vMerge === 'continue') rowspan++; else break;
        }
      }
      const td = ctx.hd.createElement(row.header ? 'th' : 'td');
      if (cell.span > 1) td.setAttribute('colspan', String(cell.span));
      if (rowspan > 1) td.setAttribute('rowspan', String(rowspan));
      convertBlocks(ctx, kids(cell.tc).filter((c) => c.localName !== 'tcPr'), td, opts);
      // 칸 안 문단이 하나뿐이면 p를 풀어 줄 간격을 줄인다
      if (td.children.length === 1 && td.firstElementChild.tagName === 'P') {
        const p = td.firstElementChild;
        p.replaceWith(...p.childNodes);
      }
      trEl.append(td);
    }
    if (trEl.children.length) t.append(trEl);
  });
  const wrap = ctx.hd.createElement('div');
  wrap.className = 'g-table';
  wrap.append(t);
  return wrap;
}
