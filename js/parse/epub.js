// EPUB → 구획(장) 목록. 원래 HTML 구조와 책 CSS를 살려 두어 전자책 보기에서 책 모양 그대로 보여 준다.
import { unzipSync, strFromU8 } from '../../vendor/fflate.mjs';
import {
  purify, cleanInlineStyle, scopeCss, joinPath, normalizePath, safeDecode, newHtmlDoc, mimeOf, makeThumb, blobFrom,
} from './common.js';

const MAX_TOTAL = 900 * 1024 * 1024;

export class ParseError extends Error {}

export function unzipEpub(bytes, { onlyResources = false } = {}) {
  let total = 0;
  return unzipSync(bytes, {
    filter(file) {
      if (file.name.endsWith('/')) return false;
      if (onlyResources && !/\.(jpe?g|png|gif|webp|svg|bmp|avif|ttf|otf|woff2?|css)$/i.test(file.name)) return false;
      total += file.originalSize || 0;
      if (total > MAX_TOTAL) throw new ParseError('압축을 푼 크기가 너무 큽니다(안전 검사).');
      return true;
    },
  });
}

function findEntry(files, path) {
  if (files[path]) return path;
  const lower = path.toLowerCase();
  for (const name of Object.keys(files)) if (name.toLowerCase() === lower) return name;
  return null;
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  return doc;
}

const byLocal = (root, name) => [...root.getElementsByTagNameNS('*', name)];
const firstLocal = (root, name) => root.getElementsByTagNameNS('*', name)[0] || null;

function parseXhtml(text) {
  // XHTML로 먼저, 안 되면 HTML로
  let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (doc.getElementsByTagName('parsererror').length || !doc.body) {
    doc = new DOMParser().parseFromString(text.replace(/<\?xml[^>]*>/, ''), 'text/html');
  }
  return doc;
}

// 글꼴 난독화 풀기(IDPF·Adobe) — DRM이 아니라 글꼴 재배포 방지용이라 책을 읽으려면 풀어야 한다
async function deobfuscate(bytes, algorithm, uid) {
  const out = new Uint8Array(bytes);
  if (algorithm === 'http://www.idpf.org/2008/embedding') {
    const key = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(uid.replace(/[ \u0009\u000d\u000a]/g, ''))));
    for (let i = 0; i < Math.min(1040, out.length); i++) out[i] ^= key[i % key.length];
  } else if (algorithm === 'http://ns.adobe.com/pdf/enc#RC') {
    const hex = uid.replace(/^urn:uuid:/i, '').replace(/-/g, '');
    if (hex.length >= 32) {
      const key = new Uint8Array(16);
      for (let i = 0; i < 16; i++) key[i] = parseInt(hex.substr(i * 2, 2), 16);
      for (let i = 0; i < Math.min(1024, out.length); i++) out[i] ^= key[i % 16];
    }
  }
  return out;
}

export async function readEpubPackage(files) {
  const containerPath = findEntry(files, 'META-INF/container.xml');
  if (!containerPath) throw new ParseError('EPUB 구조(container.xml)를 찾지 못했습니다.');
  const container = parseXml(strFromU8(files[containerPath]));
  const rootfile = container && firstLocal(container, 'rootfile')?.getAttribute('full-path');
  if (!rootfile) throw new ParseError('EPUB 패키지 정보를 찾지 못했습니다.');
  const opfPath = findEntry(files, normalizePath(safeDecode(rootfile)));
  if (!opfPath) throw new ParseError('EPUB 패키지 파일을 찾지 못했습니다.');
  const opf = parseXml(strFromU8(files[opfPath]).replace(/^﻿/, ''));
  if (!opf) throw new ParseError('EPUB 패키지 파일이 손상되었습니다.');

  const meta = firstLocal(opf, 'metadata');
  const textOf = (name) => (meta ? byLocal(meta, name).map((e) => e.textContent.trim()).filter(Boolean) : []);
  const pkg = opf.documentElement;
  const uidRef = pkg.getAttribute('unique-identifier');
  let uid = '';
  if (meta) {
    const ids = byLocal(meta, 'identifier');
    uid = (ids.find((e) => e.getAttribute('id') === uidRef) || ids[0])?.textContent.trim() || '';
  }

  const manifest = new Map();
  const byHref = new Map();
  for (const item of byLocal(opf, 'item')) {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (!id || !href || /^[a-z]+:/i.test(href)) continue;
    const path = findEntry(files, joinPath(opfPath, safeDecode(href.split('#')[0]))) || joinPath(opfPath, safeDecode(href.split('#')[0]));
    const rec = { id, href, path, type: item.getAttribute('media-type') || '', props: (item.getAttribute('properties') || '').split(/\s+/).filter(Boolean) };
    manifest.set(id, rec);
    byHref.set(path, rec);
  }
  const spineEl = firstLocal(opf, 'spine');
  const spine = [];
  if (spineEl) {
    for (const ref of byLocal(spineEl, 'itemref')) {
      const item = manifest.get(ref.getAttribute('idref'));
      if (!item) continue;
      if (!/html|xml/.test(item.type) && !/\.x?html?$/i.test(item.path)) continue;
      spine.push({ ...item, linear: ref.getAttribute('linear') !== 'no' });
    }
  }
  let coverId = null;
  for (const m of meta ? byLocal(meta, 'meta') : []) if (m.getAttribute('name') === 'cover') coverId = m.getAttribute('content');
  const coverItem = [...manifest.values()].find((i) => i.props.includes('cover-image')) || (coverId && manifest.get(coverId)) || null;

  return {
    opfPath, manifest, byHref, spine, uid,
    title: textOf('title')[0] || '',
    author: textOf('creator').join(', '),
    lang: textOf('language')[0] || '',
    publisher: textOf('publisher')[0] || '',
    navItem: [...manifest.values()].find((i) => i.props.includes('nav')) || null,
    ncxItem: (spineEl && manifest.get(spineEl.getAttribute('toc'))) || [...manifest.values()].find((i) => i.type === 'application/x-dtbncx+xml') || null,
    coverItem,
  };
}

// 열 때 쓰는 그림·글꼴(Blob)
export async function epubResources(files, pkg) {
  const encrypted = await readEncryption(files);
  const res = new Map();
  for (const item of pkg.manifest.values()) {
    if (!/^(image|font)\//.test(item.type) && !/\.(jpe?g|png|gif|webp|svg|bmp|avif|ttf|otf|woff2?)$/i.test(item.path) && !/opentype|truetype|woff|font/.test(item.type)) continue;
    const name = findEntry(files, item.path);
    if (!name) continue;
    let bytes = files[name];
    const enc = encrypted.get(name);
    if (enc) {
      if (!enc.font) continue;
      bytes = await deobfuscate(bytes, enc.algorithm, pkg.uid);
    }
    res.set(item.path, blobFrom(bytes, item.type || mimeOf(item.path)));
  }
  return res;
}

async function readEncryption(files) {
  const map = new Map();
  const path = findEntry(files, 'META-INF/encryption.xml');
  if (!path) return map;
  const xml = parseXml(strFromU8(files[path]));
  if (!xml) return map;
  for (const data of byLocal(xml, 'EncryptedData')) {
    const algorithm = firstLocal(data, 'EncryptionMethod')?.getAttribute('Algorithm') || '';
    const uri = firstLocal(data, 'CipherReference')?.getAttribute('URI') || '';
    if (!uri) continue;
    const font = algorithm === 'http://www.idpf.org/2008/embedding' || algorithm === 'http://ns.adobe.com/pdf/enc#RC';
    const name = findEntry(files, normalizePath(safeDecode(uri)));
    if (name) map.set(name, { algorithm, font });
  }
  return map;
}

export async function parseEpub(bytes, { onProgress } = {}) {
  let files;
  try {
    files = unzipEpub(bytes);
  } catch (e) {
    if (e instanceof ParseError) throw e;
    throw new ParseError('EPUB 압축을 풀지 못했습니다. 파일이 손상되었을 수 있습니다.');
  }
  const pkg = await readEpubPackage(files);
  const encrypted = await readEncryption(files);
  for (const [name, enc] of encrypted) {
    if (!enc.font && pkg.spine.some((s) => s.path === name)) {
      throw new ParseError('DRM(복제 방지)이 걸린 전자책이라 열 수 없습니다.');
    }
  }
  if (!pkg.spine.length) throw new ParseError('EPUB 읽기 순서(spine)가 비어 있습니다.');

  const sectionIndex = new Map(pkg.spine.map((s, i) => [s.path, i]));
  const htmlDoc = newHtmlDoc();
  const styles = {};
  const cssCache = new Map();
  const knownRes = new Set([...pkg.manifest.values()].map((i) => i.path));
  const resolveRes = (fromPath) => (url) => {
    if (/^(data|https?|blob):/i.test(url)) return null;
    const p = joinPath(fromPath, safeDecode(url.split('#')[0].split('?')[0]));
    const real = findEntry(files, p);
    return real && knownRes.has(real) ? real : (real || null);
  };

  const loadCss = (path, depth = 0) => {
    if (cssCache.has(path)) return cssCache.get(path);
    const name = findEntry(files, path);
    if (!name || depth > 4) return '';
    let text = '';
    try { text = new TextDecoder('utf-8').decode(files[name]).replace(/^﻿/, ''); } catch { text = ''; }
    // @import 를 펼친다
    text = text.replace(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?[^;]*;/gi, (m, href) => {
      const sub = joinPath(name, safeDecode(href));
      return loadCssRaw(sub, depth + 1);
    });
    const scoped = scopeCss(text, resolveRes(name));
    cssCache.set(path, scoped);
    return scoped;
  };
  const loadCssRaw = (path, depth) => {
    const name = findEntry(files, path);
    if (!name || depth > 4) return '';
    try { return new TextDecoder('utf-8').decode(files[name]); } catch { return ''; }
  };

  const sections = [];
  for (let s = 0; s < pkg.spine.length; s++) {
    const item = pkg.spine[s];
    const name = findEntry(files, item.path);
    let html = '';
    let bodyClass = '';
    let lang = '';
    const styleKeys = [];
    if (name) {
      let raw = '';
      try { raw = new TextDecoder('utf-8').decode(files[name]).replace(/^﻿/, ''); } catch { raw = ''; }
      const doc = parseXhtml(raw);
      lang = doc.documentElement?.getAttribute('lang') || doc.documentElement?.getAttribute('xml:lang') || '';
      // 책 CSS 모으기
      for (const link of doc.querySelectorAll('link[rel~="stylesheet" i][href], link[type="text/css"][href]')) {
        const cssPath = joinPath(name, safeDecode(link.getAttribute('href').split('#')[0]));
        const key = `f:${cssPath}`;
        if (!(key in styles)) styles[key] = loadCss(cssPath);
        if (styles[key]) styleKeys.push(key);
      }
      let inline = 0;
      for (const st of doc.querySelectorAll('style')) {
        const key = `i:${s}:${inline++}`;
        styles[key] = scopeCss(st.textContent || '', resolveRes(name));
        if (styles[key]) styleKeys.push(key);
      }
      const body = doc.body || doc.querySelector('body');
      if (body) {
        bodyClass = (body.getAttribute('class') || '').trim();
        html = transformBody(body, { htmlDoc, path: name, files, sectionIndex, resolveRes: resolveRes(name) });
      }
    }
    sections.push({ href: item.path, html, bodyClass, lang, styles: styleKeys, linear: item.linear });
    if (onProgress && s % 4 === 0) {
      onProgress((s + 1) / pkg.spine.length);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const toc = readToc(files, pkg, sectionIndex);

  let cover = null;
  if (pkg.coverItem) {
    const name = findEntry(files, pkg.coverItem.path);
    if (name && /^image\//.test(pkg.coverItem.type || mimeOf(name))) {
      cover = await makeThumb(blobFrom(files[name], pkg.coverItem.type || mimeOf(name)));
    }
  }
  if (!cover) {
    // 첫 장이 그림 한 장뿐이면 표지로 본다
    const first = sections[0];
    const m = first && /data-g-src="([^"]+)"/.exec(first.html);
    if (m && first.html.replace(/<[^>]+>/g, '').trim().length < 40) {
      const name = findEntry(files, m[1]);
      if (name) cover = await makeThumb(blobFrom(files[name], mimeOf(name)));
    }
  }

  return {
    book: {
      format: 'epub',
      title: pkg.title,
      author: pkg.author,
      lang: pkg.lang || sections.find((s) => s.lang)?.lang || '',
      publisher: pkg.publisher,
      sections,
      styles,
      tocRaw: toc,
    },
    cover,
  };
}

const NOTE_TYPES = /\b(noteref|footnote|endnote|rearnote|note|biblioref|glossref)\b/;

function transformBody(body, { htmlDoc, path, files, sectionIndex, resolveRes }) {
  const box = htmlDoc.createElement('div');
  for (const child of [...body.childNodes]) box.append(htmlDoc.importNode(child, true));

  for (const el of [...box.querySelectorAll('script, style, link, meta, noscript, iframe, object, embed, form, video, audio, canvas')]) el.remove();

  // epub:type → data-epub-type (가져오는 과정에서 이름공간 속성이 섞이므로 이름으로 찾는다)
  for (const el of box.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const local = attr.localName;
      if (attr.name === 'epub:type' || (local === 'type' && attr.namespaceURI === 'http://www.idpf.org/2007/ops')) {
        el.setAttribute('data-epub-type', attr.value);
      }
      if (attr.name.includes(':') && attr.name !== 'xml:lang') {
        try { el.removeAttribute(attr.name); } catch { /* 이름공간 속성 */ }
        if (attr.namespaceURI) try { el.removeAttributeNS(attr.namespaceURI, local); } catch { /* 무시 */ }
      }
    }
    if (el.hasAttribute('style')) {
      const cleaned = cleanInlineStyle(el.getAttribute('style'));
      if (cleaned.trim()) el.setAttribute('style', cleaned); else el.removeAttribute('style');
    }
  }

  // <svg><image href> 표지 → <img>
  for (const svg of [...box.querySelectorAll('svg')]) {
    const image = svg.querySelector('image');
    if (!image) continue;
    const href = image.getAttribute('href') || image.getAttribute('xlink:href') || image.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
    const key = href ? resolveRes(href) : null;
    if (key) {
      const img = htmlDoc.createElement('img');
      img.setAttribute('data-g-src', key);
      img.setAttribute('alt', '');
      img.className = 'g-svgimg';
      svg.replaceWith(img);
    }
  }

  for (const img of [...box.querySelectorAll('img')]) {
    const src = img.getAttribute('src');
    img.removeAttribute('src');
    img.removeAttribute('srcset');
    const key = src ? resolveRes(src) : null;
    if (key) {
      img.setAttribute('data-g-src', key);
      img.setAttribute('loading', 'lazy');
    } else {
      const alt = img.getAttribute('alt');
      if (alt) img.replaceWith(htmlDoc.createTextNode(`[${alt}]`)); else img.remove();
    }
  }

  for (const a of box.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href').trim();
    if (/^(https?:|mailto:)/i.test(href)) {
      a.setAttribute('data-ext', '1');
      continue;
    }
    if (/^[a-z]+:/i.test(href)) { a.removeAttribute('href'); continue; }
    const [file, frag = ''] = href.split('#');
    let s;
    if (!file) s = sectionIndex.get(path);
    else {
      const target = findEntry(files, joinPath(path, safeDecode(file))) || joinPath(path, safeDecode(file));
      s = sectionIndex.get(target);
    }
    if (s == null) { a.removeAttribute('href'); continue; }
    a.setAttribute('href', `#g:${s}:${frag}`);
  }
  for (const el of box.querySelectorAll('[data-epub-type]')) {
    if (NOTE_TYPES.test(el.getAttribute('data-epub-type'))) el.classList.add('g-note-el');
  }
  return purify(box.innerHTML);
}

function readToc(files, pkg, sectionIndex) {
  const entries = [];
  const resolve = (from, href) => {
    if (!href) return null;
    const [file, frag = ''] = href.split('#');
    const path = file ? (findEntry(files, joinPath(from, safeDecode(file))) || joinPath(from, safeDecode(file))) : from;
    const s = sectionIndex.get(path);
    return s == null ? null : { s, frag: safeDecode(frag) };
  };
  if (pkg.navItem) {
    const name = findEntry(files, pkg.navItem.path);
    if (name) {
      const doc = parseXhtml(new TextDecoder('utf-8').decode(files[name]));
      const navs = [...doc.getElementsByTagName('nav')];
      const nav = navs.find((n) => /\btoc\b/.test(n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '')) || navs[0];
      if (nav) {
        const walk = (list, level) => {
          for (const li of [...list.children].filter((c) => c.localName === 'li')) {
            const a = [...li.children].find((c) => c.localName === 'a' || c.localName === 'span');
            const title = (a?.textContent || '').replace(/\s+/g, ' ').trim();
            const target = a && a.localName === 'a' ? resolve(name, a.getAttribute('href')) : null;
            if (title && target) entries.push({ title, level, ...target });
            const sub = [...li.children].find((c) => c.localName === 'ol' || c.localName === 'ul');
            if (sub) walk(sub, level + 1);
          }
        };
        const top = [...nav.children].find((c) => c.localName === 'ol' || c.localName === 'ul');
        if (top) walk(top, 1);
      }
    }
  }
  if (!entries.length && pkg.ncxItem) {
    const name = findEntry(files, pkg.ncxItem.path);
    const ncx = name && parseXml(new TextDecoder('utf-8').decode(files[name]).replace(/^﻿/, ''));
    const navMap = ncx && firstLocal(ncx, 'navMap');
    if (navMap) {
      const walk = (parent, level) => {
        for (const point of [...parent.children].filter((c) => c.localName === 'navPoint')) {
          const label = firstLocal(point, 'text')?.textContent.replace(/\s+/g, ' ').trim() || '';
          const content = [...point.children].find((c) => c.localName === 'content');
          const target = content ? resolve(name, content.getAttribute('src')) : null;
          if (label && target) entries.push({ title: label, level, ...target });
          walk(point, level + 1);
        }
      };
      walk(navMap, 1);
    }
  }
  return entries;
}
