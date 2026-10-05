// 문서 변환 입구: 형식을 가려 변환하고, 구획마다 글·제목·목차 위치를 계산한다.
import { analyzeSection, addBlockBreaks, PARSER_VERSION } from './common.js';
import { parseEpub, ParseError } from './epub.js';
import { parseDocx } from './docx.js';
import { parseText, parseMarkdown } from './plain.js';
import { fileExt } from '../util.js';

export { PARSER_VERSION, ParseError };

export const FORMATS = {
  epub: { label: 'EPUB', mime: 'application/epub+zip' },
  pdf: { label: 'PDF', mime: 'application/pdf' },
  docx: { label: 'DOCX', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  md: { label: 'MD', mime: 'text/markdown' },
  txt: { label: 'TXT', mime: 'text/plain' },
};

export const ACCEPT = '.epub,.pdf,.docx,.md,.markdown,.txt,application/epub+zip,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown';

export function detectFormat(name, type = '') {
  const ext = fileExt(name);
  if (ext === 'epub' || type === 'application/epub+zip') return 'epub';
  if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
  if (ext === 'docx' || type === FORMATS.docx.mime) return 'docx';
  if (ext === 'md' || ext === 'markdown' || type === 'text/markdown') return 'md';
  if (ext === 'txt' || ext === 'text' || type === 'text/plain') return 'txt';
  return null;
}

export async function sniffFormat(blob, name) {
  const byName = detectFormat(name, blob.type);
  if (byName) return byName;
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const str = String.fromCharCode(...head);
  if (str.startsWith('%PDF')) return 'pdf';
  if (str.startsWith('PK')) {
    if (str.includes('mimetypeapplication/epub+zip')) return 'epub';
    return 'docx';
  }
  return null;
}

// 문서 → { book, texts, cover }
export async function parseDocument(blob, format, { onProgress } = {}) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!bytes.length) throw new ParseError('내용이 없는 파일입니다.');
  let result;
  if (format === 'epub') result = await parseEpub(bytes, { onProgress });
  else if (format === 'docx') result = await parseDocx(bytes);
  else if (format === 'md') result = parseMarkdown(bytes);
  else if (format === 'txt') result = parseText(bytes);
  else throw new ParseError('지원하지 않는 형식입니다.');
  const { book, cover } = result;
  const texts = [];
  const headings = [];
  const idMaps = [];
  let total = 0;
  for (let s = 0; s < book.sections.length; s++) {
    const sec = book.sections[s];
    sec.html = addBlockBreaks(sec.html);
    const a = analyzeSection(sec.html);
    sec.chars = a.chars;
    sec.start = total;
    total += a.chars;
    texts.push(a.text);
    for (const h of a.headings) headings.push({ s, ...h });
    idMaps.push(a.ids);
    if (s % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
  book.chars = total;
  book.headings = headings;
  // 목차: EPUB 목차가 있으면 그 위치를, 없으면 제목들로
  let toc = [];
  if (book.tocRaw?.length) {
    for (const e of book.tocRaw) {
      const o = e.frag ? idMaps[e.s]?.get(e.frag) : 0;
      toc.push({ title: e.title, level: Math.min(6, Math.max(1, e.level)), s: e.s, o: o ?? 0 });
    }
  } else {
    toc = headings.map((h) => ({ title: h.title, level: h.level, s: h.s, o: h.o }));
  }
  delete book.tocRaw;
  book.toc = toc;
  if (!book.lang) book.lang = guessLang(texts.join('').slice(0, 4000));
  if (total === 0 && !book.sections.some((s) => /data-g-src/.test(s.html))) {
    throw new ParseError('표시할 수 있는 본문을 찾지 못했습니다.');
  }
  return { book, texts, cover };
}

export function guessLang(sample) {
  const hangul = (sample.match(/[가-힣]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  const kana = (sample.match(/[぀-ヿ]/g) || []).length;
  const han = (sample.match(/[一-鿿]/g) || []).length;
  if (hangul >= latin * 0.25 && hangul > 0) return 'ko';
  if (kana > 20) return 'ja';
  if (han > latin) return 'zh';
  if (latin > 0) return 'en';
  return 'ko';
}
