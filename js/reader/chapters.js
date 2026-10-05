// 장(챕터) 나누기 — 안드로이드 앱의 Divided·Random 규칙을 그대로 옮겼다.
const FRONT = /^(?:표지|목차|차례|판권|저작권|앞부분|contents|table of contents|cover|copyright|title page)(?:\s|$)/i;
const STRUCTURAL = /^(?:프롤로그|에필로그|머리말|서문|들어가며|맺음말|후기|prologue|epilogue|preface|introduction|afterword)(?:\s|$)/i;

export function toGlobal(book, s, o) {
  const sec = book.sections[s];
  if (!sec) return book.chars;
  return sec.start + Math.max(0, Math.min(o, sec.chars));
}

export function fromGlobal(book, g) {
  const secs = book.sections;
  let lo = 0;
  let hi = secs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (secs[mid].start <= g) lo = mid; else hi = mid - 1;
  }
  // 빈 구획(그림만 있는 장)은 건너뛰지 않는다 — 같은 위치면 앞 구획
  return { s: lo, o: Math.max(0, Math.min(g - secs[lo].start, secs[lo].chars)) };
}

export function buildChapters(book, texts) {
  const total = book.chars;
  const source = book.toc.length >= 2 ? book.toc : book.headings;
  const seen = new Map();
  for (const e of source) {
    const g = toGlobal(book, e.s, e.o);
    const prev = seen.get(g);
    if (!prev || e.level < prev.level) seen.set(g, { title: e.title, level: e.level, g });
  }
  const cands = [...seen.values()].sort((a, b) => a.g - b.g);
  if (!cands.length) return [{ title: '전체 문서', start: 0, end: total }];

  const counts = new Map();
  for (const c of cands) counts.set(c.level, (counts.get(c.level) || 0) + 1);
  const minLevel = Math.min(...counts.keys());
  let structural = minLevel;
  if (counts.get(minLevel) === 1) {
    const deeper = [...counts.entries()].filter(([lvl, n]) => lvl > minLevel && n >= 2).map(([lvl]) => lvl);
    if (deeper.length) structural = Math.min(...deeper);
  }
  const top = cands.filter((c) => c.level === structural);
  const bounds = new Map(top.map((c) => [c.g, c.title]));
  if (structural !== minLevel && top.length) {
    const first = top[0].g;
    const last = top[top.length - 1].g;
    for (const c of cands) {
      if ((c.g < first || c.g > last) && STRUCTURAL.test(c.title)) bounds.set(c.g, c.title);
    }
  }
  const ordered = [...bounds.entries()].sort((a, b) => a[0] - b[0]);
  if (ordered.length && ordered[0][0] > 0) {
    const firstText = (texts?.[0] || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    ordered.unshift([0, firstText && ordered[0][0] > 0 ? '앞부분' : '앞부분']);
  }
  const chapters = [];
  for (let i = 0; i < ordered.length; i++) {
    const start = ordered[i][0];
    const end = i + 1 < ordered.length ? ordered[i + 1][0] : total;
    if (end <= start && i + 1 < ordered.length) continue;
    chapters.push({ title: ordered[i][1], start, end: Math.max(end, start) });
  }
  return chapters.length ? chapters : [{ title: '전체 문서', start: 0, end: total }];
}

export function chapterAt(chapters, g) {
  let idx = 0;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].start <= g) idx = i; else break;
  }
  return idx;
}

export function randomChapter(chapters, excluding = -1) {
  let cands = chapters.map((c, i) => i).filter((i) => !FRONT.test(chapters[i].title.trim()) && chapters[i].end > chapters[i].start);
  if (!cands.length) cands = chapters.map((c, i) => i);
  if (excluding >= 0 && cands.length > 1) cands = cands.filter((i) => i !== excluding);
  return cands[Math.floor(Math.random() * cands.length)];
}

export const isFrontMatter = (title) => FRONT.test(String(title || '').trim());
