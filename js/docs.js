// 문서 가져오기·열기 준비(변환본 보관, 그림·글꼴 꺼내기)
import { db } from './db.js';
import { state, saveDoc, saveInfo, putFile, getFile, liveDocs, localFileHashes } from './store.js';
import { parseDocument, sniffFormat, PARSER_VERSION, ParseError } from './parse/index.js';
import { pdfInfo, openPdf, pdfTexts, closePdf } from './pdfdoc.js';
import { unzipEpub, readEpubPackage, epubResources } from './parse/epub.js';
import { unzipDocx, docxResources } from './parse/docx.js';
import { uid, baseName, emit, now } from './util.js';
import { buildChapters } from './reader/chapters.js';

// 노트·검색 화면이 책 전체를 열지 않고도 위치(장 제목·%)를 셀 수 있게 작은 요약을 남긴다
export function bookSummary(book, texts) {
  return {
    starts: book.sections.map((s) => s.start),
    chaps: buildChapters(book, texts).map((c) => [c.start, c.title.slice(0, 80)]),
  };
}

export const MAX_FILE = 400 * 1024 * 1024;

export class ImportError extends Error {}

// 파일 여러 개 가져오기 → [{doc, error, name, duplicate}]
export async function importFiles(files, { onStatus } = {}) {
  const results = [];
  let i = 0;
  for (const file of files) {
    i++;
    onStatus?.(`${i}/${files.length} · ${file.name}`);
    try {
      results.push(await importOne(file, file.name, { onStatus: (m) => onStatus?.(`${i}/${files.length} · ${m}`) }));
    } catch (e) {
      const quota = e?.name === 'QuotaExceededError' || /quota/i.test(e?.message || '');
      results.push({ name: file.name, error: quota ? '이 기기의 저장 공간이 부족합니다. 안 읽는 문서를 지우거나 공간을 비워 주세요.' : e instanceof ParseError || e instanceof ImportError ? e.message : `가져오지 못했습니다: ${e?.message || e}` });
    }
  }
  return results;
}

export async function importOne(blob, name, { onStatus, id, addedAt, title } = {}) {
  if (!blob.size) throw new ImportError('내용이 없는 파일입니다.');
  if (blob.size > MAX_FILE) throw new ImportError('파일이 너무 큽니다(400MB 초과).');
  const format = await sniffFormat(blob, name);
  if (!format) throw new ImportError('TXT·Markdown·DOCX·PDF·EPUB 파일만 열 수 있습니다.');
  const hash = await putFile(blob, name);
  const dup = liveDocs().find((d) => d.fileHash === hash);
  if (dup && !id) return { name, doc: dup, duplicate: true };
  const docId = id || uid('d');
  let meta = { title: '', author: '' };
  let info = { docId, format };
  try {
    if (format === 'pdf') {
      onStatus?.('PDF 읽는 중');
      let pi;
      try {
        pi = await pdfInfo(blob);
      } catch (e) {
        throw new ImportError(/password/i.test(e?.name || e?.message || '') ? '암호가 걸린 PDF는 열 수 없습니다.' : 'PDF를 열 수 없습니다. 파일이 손상되었을 수 있습니다.');
      }
      meta = { title: pi.title, author: pi.author };
      info = { ...info, pages: pi.pages, cover: pi.cover, chars: 0 };
    } else {
      onStatus?.('변환 중');
      const { book, texts, cover } = await parseDocument(blob, format, { onProgress: (p) => onStatus?.(`변환 중 ${Math.round(p * 100)}%`) });
      await db.put('cache', { docId, fileHash: hash, pv: PARSER_VERSION, book, texts });
      meta = { title: book.title, author: book.author };
      info = { ...info, chars: book.chars, lang: book.lang, cover, sections: book.sections.length, ...bookSummary(book, texts) };
    }
  } catch (e) {
    // 실패한 파일은 저장소에 남기지 않는다
    if (!liveDocs().some((d) => d.fileHash === hash)) {
      await db.del('files', hash).catch(() => {});
      (await localFileHashes()).delete(hash);
    }
    await db.del('cache', docId).catch(() => {});
    throw e;
  }
  const fileTitle = baseName(name) || '제목 없는 문서';
  const doc = await saveDoc({
    id: docId,
    title: title || (format === 'epub' && meta.title ? meta.title : fileTitle),
    author: meta.author || '',
    format,
    fileName: name,
    fileHash: hash,
    fileSize: blob.size,
    addedAt: addedAt || now(),
    deleted: false,
  });
  await saveInfo(info);
  return { name, doc };
}

// 변환본 불러오기(없거나 낡았으면 원본에서 다시 변환)
export async function loadBook(doc, { onStatus, fetchFile } = {}) {
  const cached = await db.get('cache', doc.id);
  if (cached && cached.fileHash === doc.fileHash && cached.pv === PARSER_VERSION && cached.book) return cached;
  const blob = await requireFile(doc, { onStatus, fetchFile });
  onStatus?.('문서 변환 중');
  const { book, texts, cover } = await parseDocument(blob, doc.format, { onProgress: (p) => onStatus?.(`문서 변환 중 ${Math.round(p * 100)}%`) });
  const rec = { docId: doc.id, fileHash: doc.fileHash, pv: PARSER_VERSION, book, texts };
  await db.put('cache', rec);
  const info = state.info.get(doc.id) || { docId: doc.id };
  await saveInfo({ ...info, docId: doc.id, format: doc.format, chars: book.chars, lang: book.lang, cover: info.cover || cover, sections: book.sections.length, ...bookSummary(book, texts) });
  return rec;
}

export async function requireFile(doc, { onStatus, fetchFile } = {}) {
  let blob = await getFile(doc.fileHash);
  if (blob) return blob;
  if (!fetchFile) throw new ImportError('이 기기에 원본 파일이 없습니다. Dropbox를 연결하면 받아 올 수 있습니다.');
  onStatus?.('Dropbox에서 원본 받는 중');
  blob = await fetchFile(doc, onStatus);
  if (!blob) throw new ImportError('원본 파일을 받지 못했습니다.');
  return blob;
}

// 그림·글꼴 → 화면용 주소
export async function loadResources(doc, blob) {
  const urls = new Map();
  if (doc.format !== 'epub' && doc.format !== 'docx') return { urls, revoke() {} };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let res;
  if (doc.format === 'epub') {
    const files = unzipEpub(bytes, { onlyResources: false });
    const pkg = await readEpubPackage(files);
    res = await epubResources(files, pkg);
  } else {
    res = docxResources(unzipDocx(bytes));
  }
  for (const [key, b] of res) urls.set(key, URL.createObjectURL(b));
  return { urls, revoke() { for (const u of urls.values()) URL.revokeObjectURL(u); urls.clear(); } };
}

// PDF 쪽별 글(검색·노트용) — 처음 한 번 뽑아 보관
export async function loadPdfTexts(doc, pdf) {
  const cached = await db.get('cache', doc.id);
  if (cached && cached.fileHash === doc.fileHash && cached.pdfTexts) return cached.pdfTexts;
  let own = null;
  let target = pdf;
  if (!target) {
    const blob = await getFile(doc.fileHash);
    if (!blob) return null;
    own = await openPdf(blob);
    target = own;
  }
  try {
    const texts = await pdfTexts(target);
    await db.put('cache', { docId: doc.id, fileHash: doc.fileHash, pv: PARSER_VERSION, pdfTexts: texts });
    const info = state.info.get(doc.id) || { docId: doc.id };
    await saveInfo({ ...info, chars: texts.reduce((n, t) => n + t.length, 0), pages: texts.length });
    return texts;
  } finally {
    if (own) closePdf(own);
  }
}

// 문서의 검색용 글(본문 구획 또는 PDF 쪽)
export async function searchableTexts(doc) {
  const cached = await db.get('cache', doc.id);
  if (!cached || cached.fileHash !== doc.fileHash) return null;
  if (doc.format === 'pdf') return cached.pdfTexts ? { kind: 'pdf', texts: cached.pdfTexts } : null;
  if (cached.texts) return { kind: 'text', texts: cached.texts, book: cached.book };
  return null;
}

export function coverUrlCache() {
  const map = new Map();
  return {
    get(docId) {
      const info = state.info.get(docId);
      if (!info?.cover) return null;
      let entry = map.get(docId);
      if (entry && entry.blob === info.cover) return entry.url;
      if (entry) URL.revokeObjectURL(entry.url);
      entry = { blob: info.cover, url: URL.createObjectURL(info.cover) };
      map.set(docId, entry);
      return entry.url;
    },
  };
}

export function emitLibraryChanged() {
  emit('docs', {});
}

// 다른 기기에서 넘어온 문서를 미리 준비(표지·글자 수·찾기용 글) — 동기화 뒤 한가할 때 조금씩
let preparing = false;
let budget = 120 * 1024 * 1024;
export async function prepareMissing({ fetchFile, maxFile = 25 * 1024 * 1024 } = {}) {
  if (preparing) return;
  preparing = true;
  try {
    for (const doc of liveDocs()) {
      const info = state.info.get(doc.id);
      const ready = doc.format === 'pdf' ? info?.pages : info?.chars != null && info?.starts;
      if (ready) continue;
      let blob = await getFile(doc.fileHash);
      if (!blob) {
        if (!fetchFile || !doc.fileSize || doc.fileSize > maxFile || doc.fileSize > budget) continue;
        try { blob = await fetchFile(doc); } catch { blob = null; }
        if (!blob) continue;
        budget -= blob.size;
      }
      try {
        if (doc.format === 'pdf') {
          const pi = await pdfInfo(blob);
          await saveInfo({ ...(state.info.get(doc.id) || {}), docId: doc.id, format: 'pdf', pages: pi.pages, cover: pi.cover, chars: 0 });
        } else {
          await loadBook(doc, {});
        }
      } catch (e) {
        console.warn('미리 준비 실패', doc.title, e);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    preparing = false;
  }
}
