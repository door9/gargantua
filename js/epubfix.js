// 띄어쓰기 고침을 EPUB 원본 파일에 넣기(2026-11-24 사용자 "고친 내용이 많이 쌓였을 때 한번에 저장… 데이터 소모가 많은 작업이니 수동으로").
// 고침 기록(fixes.js)은 '앱이 변환한 글'의 위치라 원본 XHTML 위치와 다르다(태그·문자 표기·문단 사이 줄바꿈). 그래서
//  · 원본 XHTML 을 다시 쓰지 않고 글자 자리만 센다 — 태그·주석·script/style 은 건너뛰고 &…; 는 풀어 한 글자로(원본에서 차지한 범위를 기억)
//  · 고칠 자리는 앞뒤 원래 글(24자)을 빈칸을 모두 빼고 맞춰 찾는다(EPUB 장 = 원본 XHTML 파일 하나, book.sections[s].href)
//  · 그 자리에 빈칸 한 글자를 넣거나(ins) 빈칸 한 글자를 뺀다(del) — 나머지 바이트는 그대로. 고친 파일을 다시 해석해 보아 깨지면 그 파일은 넣지 않는다
//  · 압축은 mimetype 을 맨 앞에 압축 없이, 나머지는 원래 순서로
import { unzipSync, zipSync } from '../vendor/fflate.mjs';
import { SPACE_CH } from './fixes.js';

const CTX = 24;
const sq = (s) => s.replace(/[\s 　]+/g, '');

let decoder = null;
function decodeEntity(ent) {
  const m = /^&#(x[0-9a-f]+|\d+);$/i.exec(ent);
  if (m) {
    const n = m[1][0].toLowerCase() === 'x' ? parseInt(m[1].slice(1), 16) : parseInt(m[1], 10);
    try { return String.fromCodePoint(n); } catch { return null; }
  }
  const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }[ent];
  if (named) return named;
  decoder ||= document.createElement('textarea');
  decoder.innerHTML = ent;
  return decoder.value !== ent ? decoder.value : null;
}

// 원본 XHTML 의 본문 글자: text(풀어 쓴 글) + 글자마다 원본 범위 [a, b)
export function scanText(src) {
  const text = [];
  const a = [];
  const b = [];
  const bodyAt = /<body[\s>]/i.exec(src);
  let i = bodyAt ? src.indexOf('>', bodyAt.index) + 1 : 0;
  const endBody = src.search(/<\/body\s*>/i);
  const end = endBody > i ? endBody : src.length;
  // UTF-16 한 칸씩(앱의 글자 위치와 같은 셈 — 한 문자 표기가 두 칸이 될 수도 있다)
  const push = (ch, from, to) => {
    for (let k = 0; k < ch.length; k++) { text.push(ch[k]); a.push(from); b.push(to); }
  };
  while (i < end) {
    const c = src[i];
    if (c === '<') {
      if (src.startsWith('<!--', i)) { const j = src.indexOf('-->', i + 4); i = j < 0 ? end : j + 3; continue; }
      if (src.startsWith('<![CDATA[', i)) {
        const j = src.indexOf(']]>', i + 9);
        const stop = j < 0 ? end : j;
        for (let k = i + 9; k < stop; k++) push(src[k], k, k + 1);
        i = j < 0 ? end : j + 3;
        continue;
      }
      // 태그 — 따옴표 안의 > 는 건너뛴다
      let j = i + 1;
      let q = '';
      for (; j < end; j++) {
        const d = src[j];
        if (q) { if (d === q) q = ''; continue; }
        if (d === '"' || d === "'") { q = d; continue; }
        if (d === '>') break;
      }
      const tag = /^<\s*([a-z][\w:-]*)/i.exec(src.slice(i, Math.min(j, i + 40)))?.[1]?.toLowerCase();
      i = j + 1;
      // script·style 안은 글이 아니다
      if ((tag === 'script' || tag === 'style') && src[j - 1] !== '/') {
        const close = src.slice(i).search(new RegExp(`</${tag}\\s*>`, 'i'));
        i = close < 0 ? end : i + close;
      }
      continue;
    }
    if (c === '&') {
      const m = /^&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/i.exec(src.slice(i, i + 12));
      const ch = m ? decodeEntity(m[0]) : null;
      if (ch != null) { push(ch, i, i + m[0].length); i += m[0].length; continue; }
    }
    // 글 한 글자(UTF-16 한 칸 — 앱의 글자 위치와 같은 셈)
    text.push(c); a.push(i); b.push(i + 1);
    i++;
  }
  return { text: text.join(''), a, b };
}

// 한 원본 파일에 고침들 넣기. fixes: [{op, before, after, near}] (near = 그 장 안에서 몇 % 쯤인지)
// → { src(고친 원본), done: [고친 것의 순서…] }
export function bakeFile(src, fixes) {
  const scan = scanText(src);
  // 빈칸을 뺀 글과 그 글자의 자리
  let s = '';
  const at = [];
  for (let k = 0; k < scan.text.length; k++) {
    if (SPACE_CH.test(scan.text[k])) continue;
    s += scan.text[k];
    at.push(k);
  }
  const edits = [];
  const done = [];
  fixes.forEach((f, n) => {
    const bs = sq(f.before);
    const as = sq(f.after);
    if (bs.length + as.length < 6 || !bs || !as) return;
    let best = null;
    for (let i = s.indexOf(bs + as); i >= 0; i = s.indexOf(bs + as, i + 1)) {
      const cL = at[i + bs.length - 1];
      const cR = at[i + bs.length];
      const between = scan.text.slice(cL + 1, cR);
      if (f.op === 'ins' ? between !== '' : !(between.length === 1 && SPACE_CH.test(between))) continue;
      const far = Math.abs(cL / Math.max(1, scan.text.length) - (f.near ?? 0));
      if (!best || far < best.far) best = { cL, cR, far };
    }
    if (!best) return;
    if (f.op === 'ins') edits.push({ at: scan.a[best.cR], del: 0 });
    else edits.push({ at: scan.a[best.cL + 1], del: scan.b[best.cL + 1] - scan.a[best.cL + 1] });
    done.push(n);
  });
  // 뒤에서부터(앞 자리가 밀리지 않게), 같은 자리는 한 번만
  edits.sort((x, y) => y.at - x.at);
  let out = src;
  let last = -1;
  for (const e of edits) {
    if (e.at === last) continue;
    last = e.at;
    out = e.del ? out.slice(0, e.at) + out.slice(e.at + e.del) : `${out.slice(0, e.at)} ${out.slice(e.at)}`;
  }
  return { src: out, done };
}

function parsesLike(src, before) {
  // 원래 XHTML 로 읽히던 파일은 고친 뒤에도 XHTML 로 읽혀야 한다
  const ok = (t) => !new DOMParser().parseFromString(t, 'application/xhtml+xml').getElementsByTagName('parsererror').length;
  return !ok(before) || ok(src);
}

// EPUB 원본(blob)에 고침 넣기. book·texts = 변환본(고침 전 글), plan = planFixes 결과의 plan
// → { blob, applied(넣은 고침 수), failed(못 넣은 수) }
export async function bakeEpub(blob, book, texts, plan, { onStatus } = {}) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  const find = (path) => names.find((n) => n === path) || names.find((n) => n.toLowerCase() === String(path).toLowerCase()) || null;
  // ignoreBOM: 맨 앞 BOM 을 떼지 않고 글에 남긴다(다시 쓸 때 그대로 붙인다 — 실제 책 XHTML 에 있었다)
  const enc = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let applied = 0;
  let failed = 0;
  const changed = new Map();
  let k = 0;
  for (const [s, edits] of plan) {
    k++;
    onStatus?.(`원본에 고침 넣는 중 ${Math.round((k / plan.size) * 100)}%`);
    const name = find(book.sections[s]?.href);
    const t = texts[s] || '';
    const n = edits.length;
    if (!name) { failed += n; continue; }
    let src;
    try { src = (changed.get(name) ?? enc.decode(files[name])); } catch { failed += n; continue; }
    const bom = src.startsWith('﻿') ? '﻿' : '';
    const body = bom ? src.slice(1) : src;
    const list = edits.map((e) => ({
      op: e.op,
      before: t.slice(Math.max(0, e.o - CTX), e.o),
      after: e.op === 'del' ? t.slice(e.o + 1, e.o + 1 + CTX) : t.slice(e.o, e.o + CTX),
      near: e.o / Math.max(1, t.length),
    }));
    const r = bakeFile(body, list);
    if (!r.done.length || !parsesLike(r.src, body)) { failed += n; continue; }
    changed.set(name, bom + r.src);
    applied += r.done.length;
    failed += n - r.done.length;
  }
  if (!changed.size) return { blob: null, applied: 0, failed };
  onStatus?.('새 원본 묶는 중');
  const te = new TextEncoder();
  const out = {};
  const mt = find('mimetype');
  if (mt) out[mt] = [files[mt], { level: 0 }];
  for (const name of names) {
    if (name === mt) continue;
    const data = changed.has(name) ? te.encode(changed.get(name)) : files[name];
    // 이미 압축된 그림은 다시 누르지 않는다(시간만 든다)
    out[name] = /\.(jpe?g|png|gif|webp|avif|mp3|mp4|m4a|woff2?)$/i.test(name) ? [data, { level: 0 }] : data;
  }
  const zipped = zipSync(out, { level: 6 });
  return { blob: new Blob([zipped], { type: 'application/epub+zip' }), applied, failed };
}
