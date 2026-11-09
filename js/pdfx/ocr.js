// 문자 인식(OCR) — 글자 층이 없는 PDF 쪽을 인식기(tesseract)로 읽어 PDF 글 조각과 같은 꼴로 바꾼다(배치 분석은 pdflayout.js 를 그대로 쓴다).
// DRE 의 core/ocr.js 사본에 전자책용 확장: 기울기 바로잡기, 단을 먼저 나누기, 그림 자리 찾기, 쪽별 보관 기록.
// 화면을 쓰지 않는 순수 계산.

import { spaceProb } from './joiner.js';

// RGBA → 회색조(0~255)
export function toGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    const a = rgba[i + 3];
    // 투명한 곳은 흰 바탕으로
    const k = a === 255 ? 1 : a / 255;
    g[j] = Math.round((rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) * k + 255 * (1 - k));
  }
  return g;
}

// 회색조 → PNM(P5) 바이트 — 인식기가 압축 풀기 없이 바로 읽는다
export function toPnm(gray, w, h) {
  const head = new TextEncoder().encode(`P5\n${w} ${h}\n255\n`);
  const out = new Uint8Array(head.length + gray.length);
  out.set(head, 0);
  out.set(gray, head.length);
  return out;
}

// 오츠 문턱값(글자와 바탕을 가르는 밝기)
function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i += 3) hist[gray[i]]++;
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  let sumB = 0, wB = 0, best = 0, th = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; th = i; }
  }
  return Math.min(200, Math.max(60, th));
}

// 그림에서 긴 가로·세로 선(표 테두리) 찾기 → pdflayout 의 선 꼴({ h, y|x, a, b }, 쪽 단위)
// scale: 그림 픽셀 / 쪽 단위. 짧은 획(글자)은 길이 문턱으로 거른다. 두꺼운 띠(칠한 상자)는 선이 아니다.
// 스캔한 종이는 조금씩 기울어 가로선이 계단처럼 여러 픽셀 줄에 나뉘어 찍힌다 → 이웃한 줄의 토막이 끝끼리 닿으면 한 선으로 잇는다.
export function rulesFromGray(gray, w, h, scale) {
  // 표 테두리는 연한 회색으로 찍힌 것이 많다(글자 문턱으로는 안 잡힘) → 종이 바탕보다 조금만 어두워도 선 후보로
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 5) hist[gray[i]]++;
  let bg = 255;
  for (let v = 255, best = -1; v >= 0; v--) if (hist[v] > best) { best = hist[v]; bg = v; }
  const th = Math.max(otsu(gray), Math.min(220, bg - 30));
  const out = [];
  out.shapes = [];
  out.glyphs = [];
  const minH = Math.max(w * 0.03, 30 * scale);  // 가로선: 30pt 이상
  const minV = Math.max(h * 0.012, 16 * scale); // 세로선: 16pt 이상(표 한 줄 높이)
  const maxThick = Math.max(3, 3.5 * scale);    // 3.5pt 보다 두꺼우면 선이 아니라 칠한 상자
  const gapOk = Math.max(1, Math.round(0.6 * scale)); // 선 중간의 작은 끊김은 이어 본다
  const seg = Math.max(6, Math.round(4 * scale));     // 줄마다 모을 가장 짧은 토막(약 4pt — 글자 획 대부분은 빠진다)
  const dark = (i) => gray[i] < th;
  // 가로: 행마다 토막
  const hsegs = [];
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      if (!dark(row + x)) { x++; continue; }
      let x1 = x, miss = 0, k = x;
      while (k < w) {
        if (dark(row + k)) { x1 = k; miss = 0; } else if (++miss > gapOk) break;
        k++;
      }
      if (x1 - x + 1 >= seg) hsegs.push({ y, a: x, b: x1 });
      x = k + 1;
      if (hsegs.length > 400000) break;
    }
  }
  for (const s of joinSegments(hsegs, maxThick, minH)) out.push({ h: true, y: s.c / scale, a: s.a / scale, b: s.b / scale });
  // 세로: 열마다
  const vsegs = [];
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!dark(y * w + x)) { y++; continue; }
      let y1 = y, miss = 0, k = y;
      while (k < h) {
        if (dark(k * w + x)) { y1 = k; miss = 0; } else if (++miss > gapOk) break;
        k++;
      }
      if (y1 - y + 1 >= seg) vsegs.push({ y: x, a: y, b: y1 });
      y = k + 1;
      if (vsegs.length > 400000) break;
    }
  }
  for (const s of joinSegments(vsegs, maxThick, minV)) out.push({ h: false, x: s.c / scale, a: s.a / scale, b: s.b / scale });
  return out;
}

// 이웃한 줄(y, y+1)의 토막이 겹치거나 끝끼리 닿으면(2픽셀 안) 한 덩어리로 묶는다(합집합 찾기).
// 덩어리가 길고(minLen 이상) 평균 두께가 얇으면(maxThick 이하) 선 하나. 기울기는 2°까지 받아 준다.
function joinSegments(segs, maxThick, minLen) {
  const n = segs.length;
  if (!n) return [];
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[a] = b; };
  // segs 는 줄(y) 차례·줄 안에서 a 차례로 들어온다
  let prevStart = 0, prevEnd = 0, curStart = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0 || segs[i].y !== segs[i - 1].y) {
      // 새 줄: 바로 앞 줄이 직전 줄일 때만 이웃
      if (i > 0 && segs[i].y === segs[i - 1].y + 1) { prevStart = curStart; prevEnd = i; } else { prevStart = prevEnd = i; }
      curStart = i;
    }
    const s = segs[i];
    for (let k = prevStart; k < prevEnd; k++) {
      const p = segs[k];
      if (p.a > s.b + 2) break;
      if (p.b + 2 >= s.a) union(i, k);
    }
  }
  const comp = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i), s = segs[i];
    let c = comp.get(r);
    if (!c) { c = { a: s.a, b: s.b, y0: s.y, y1: s.y, ink: 0, wy: 0 }; comp.set(r, c); }
    if (s.a < c.a) c.a = s.a;
    if (s.b > c.b) c.b = s.b;
    if (s.y < c.y0) c.y0 = s.y;
    if (s.y > c.y1) c.y1 = s.y;
    const len = s.b - s.a + 1;
    c.ink += len;
    c.wy += s.y * len;
  }
  const out = [];
  for (const c of comp.values()) {
    const len = c.b - c.a + 1;
    if (len < minLen) continue;
    if (c.ink / len > maxThick) continue;                          // 평균 두께
    if (c.y1 - c.y0 + 1 > maxThick + len * 0.035 + 2) continue;    // 2°보다 더 기울었거나 여러 선이 엉킨 것
    out.push({ c: c.wy / c.ink, a: c.a, b: c.b });
    if (out.length > 5000) break;
  }
  return out;
}

const HANGUL = /[가-힣]/g;
const IS_HANGUL = /[가-힣]/;
const ONLY_PUNCT = /^[\s'"`‘’“”,.·:;!?\-–—~]+$/;

// ─── 인식 글 바로잡기 ───
// 표 테두리(세로선·밑줄)를 글자로 잘못 읽은 것: 홀로 선 | ㅣ _ 는 버리고, 낱말 끝에 붙은 것은 떼어 낸다
const BORDER_WORD = /^[|ㅣ¦‖_]+$/;
function stripBorders(s) {
  return s.replace(/^[|ㅣ¦‖]+(?=\S)/, '').replace(/(?<=\S)[|ㅣ¦‖]+$/, '');
}

// 곧은 따옴표 → 둥근 따옴표(한국어 문서는 둥근 따옴표를 쓴다): 앞이 비었거나 여는 괄호면 여는 것, 아니면 닫는 것
function smartQuotes(s, prevEndsOpen) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "'" && c !== '"' && c !== '`') { out += c; continue; }
    const before = i === 0 ? (prevEndsOpen ? ' ' : '') : s[i - 1];
    const opening = i === 0 ? prevEndsOpen : /[\s(\[{「『〈《]/.test(before);
    if (c === '"') out += opening ? '“' : '”';
    else out += opening || c === '`' ? '‘' : '’';
  }
  return out;
}

// 괄호 짝 맞추기: 「…] 「…』 처럼 여는 것과 짝이 안 맞는 닫는 괄호를 바로잡는다(인식기가 반쪽 괄호를 헷갈린다)
const PAIR = { '「': '」', '｢': '｣', '『': '』', '(': ')', '[': ']', '“': '”', '‘': '’' };
const CLOSE_CONFUSED = { '「': /[\]』｣|]/, '｢': /[\]』」|]/, '『': /[\]」｣]/, '(': /[\]}]/ };
function fixPairs(s) {
  const stack = [];
  const out = [...s];
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (PAIR[c] && c !== '“' && c !== '‘') { stack.push(c); continue; }
    const top = stack[stack.length - 1];
    if (top && c === PAIR[top]) { stack.pop(); continue; }
    if (top && CLOSE_CONFUSED[top] && CLOSE_CONFUSED[top].test(c)) { out[i] = PAIR[top]; stack.pop(); }
  }
  return out.join('');
}

export function fixOcrText(s) {
  return s.replace(/ㆍ/g, '·'); // 한글 아래아(ㆍ)로 읽힌 가운뎃점
}
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// 두 무리로 가르는 문턱(오츠) — 값들을 '좁은 틈'과 '넓은 틈'으로 나눌 때
function splitPoint(vals, lo, hi, fallback) {
  const v = vals.filter((x) => x >= 0 && x < 1.5).sort((a, b) => a - b);
  if (v.length < 8) return fallback;
  let best = -1, th = fallback;
  let sumAll = 0;
  for (const x of v) sumAll += x;
  let sumL = 0;
  for (let i = 0; i < v.length - 1; i++) {
    sumL += v[i];
    const nL = i + 1, nR = v.length - nL;
    const mL = sumL / nL, mR = (sumAll - sumL) / nR;
    const score = nL * nR * (mR - mL) * (mR - mL);
    if (score > best && v[i + 1] > v[i]) { best = score; th = (v[i] + v[i + 1]) / 2; }
  }
  return Math.min(hi, Math.max(lo, th));
}

// ─── 글머리표 모양 읽기 ───
// 인식기는 줄 첫머리의 작은 기호(□ ○ ◦ △ ▸…)를 0·O·ㅇ·ㅁ·* 따위로 읽는다. 그림의 그 자리 화소로 모양을 가린다.
// box: 글자 상자(그림 픽셀), em: 줄 글자 크기(픽셀). 돌려주는 것: 기호 하나 또는 null(모르겠음)
const BULLET_LIKE = /^[0OoQDㅇㅁ口니ㅂ*~스를△▲▵▴▷▶▸▹□■○●◦◇◆•▪▫◎⊙@ㆍ·]$/;
export function bulletShape(img, box, em, debug = null) {
  const { gray, w: W, h: H, th } = img;
  // 글자 상자를 실제 잉크에 맞춰 줄인다(상자에 여백이 있으면 가장자리 띠가 비어 보인다)
  let x0 = Math.max(0, Math.floor(box.x0)), x1 = Math.min(W - 1, Math.ceil(box.x1) - 1);
  let y0 = Math.max(0, Math.floor(box.y0)), y1 = Math.min(H - 1, Math.ceil(box.y1) - 1);
  const dark = (x, y) => gray[y * W + x] < th;
  // 가장자리 줄에 잉크가 거의 없으면(15% 미만 — 번진 점) 잘라 낸다
  const rowHas = (y) => { let d = 0; for (let x = x0; x <= x1; x++) if (dark(x, y)) d++; return d > (x1 - x0 + 1) * 0.15; };
  const colHas = (x) => { let d = 0; for (let y = y0; y <= y1; y++) if (dark(x, y)) d++; return d > (y1 - y0 + 1) * 0.15; };
  while (y0 < y1 && !rowHas(y0)) y0++;
  while (y1 > y0 && !rowHas(y1)) y1--;
  while (x0 < x1 && !colHas(x0)) x0++;
  while (x1 > x0 && !colHas(x1)) x1--;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  if (bw < 4 || bh < 4 || bh > em * 1.2 || bh < em * 0.3) return null; // 아주 작은 점(·)은 그대로
  const ratio = bw / bh;
  if (ratio < 0.8 || ratio > 1.3) return null; // 기호는 거의 정사각(숫자 0·글자 O 는 홀쭉하다)
  const area = (ax, ay, bx, by) => { // 어두운 칸 비율(끝 포함)
    let d = 0, n = 0;
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) { n++; if (dark(x, y)) d++; }
    return n ? d / n : 0;
  };
  // 가장자리: 바깥 띠(두께 10%) 안에서 가장 많이 찬 한 줄 — 테두리가 1픽셀만큼 가늘어도 잡히게
  const b = Math.max(1, Math.round(Math.min(bw, bh) * 0.1));
  let T = 0, B = 0, L = 0, R = 0;
  for (let k = 0; k < b; k++) {
    T = Math.max(T, area(x0, y0 + k, x1, y0 + k)); B = Math.max(B, area(x0, y1 - k, x1, y1 - k));
    L = Math.max(L, area(x0 + k, y0, x0 + k, y1)); R = Math.max(R, area(x1 - k, y0, x1 - k, y1));
  }
  const c = Math.max(1, Math.round(Math.min(bw, bh) * 0.15)); // 귀퉁이 칸
  const tl = area(x0, y0, x0 + c - 1, y0 + c - 1), tr = area(x1 - c + 1, y0, x1, y0 + c - 1);
  const bl = area(x0, y1 - c + 1, x0 + c - 1, y1), br = area(x1 - c + 1, y1 - c + 1, x1, y1);
  const I = area(x0 + b + 1, y0 + b + 1, x1 - b - 1, y1 - b - 1); // 안쪽(채움)
  if (debug) debug.push({ bw, bh, T, B, L, R, tl, tr, bl, br, I });
  const small = bh < em * 0.5;
  const filled = I > 0.5;
  const hi = 0.6, lo = 0.3;
  // 네모: 네 가장자리가 다 찼다
  if (T > hi && B > hi && L > hi && R > hi) return filled ? (small ? '▪' : '■') : '□';
  // 세모(위): 밑변만 차고 윗변은 꼭짓점뿐 / 세모(오른쪽): 왼변만 차고 오른변은 꼭짓점뿐
  if (B > hi && T < lo && bl > lo && br > lo && tl < lo && tr < lo) return small ? (filled ? '▴' : '▵') : (filled ? '▲' : '△');
  if (L > hi && R < lo && tl > lo && bl > lo && tr < lo && br < lo) return small ? (filled ? '▸' : '▹') : (filled ? '▶' : '▷');
  // 귀퉁이가 다 비었으면: 가장자리에 점으로만 닿으면 마름모, 넓게 닿으면 동그라미
  if (Math.max(tl, tr, bl, br) < lo) {
    if (Math.max(T, B, L, R) < 0.25) return filled ? '◆' : '◇';
    return filled ? (small ? '•' : '●') : (small ? '◦' : '○');
  }
  return null;
}

// ─── 쪽 준비: 기울기·단 나누기·사진 자리 ───
// 잉크 문턱: 종이 바탕보다 조금만 어두워도 잉크로 본다(연한 색 칸·사진의 밝은 곳)
function inkThreshold(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i += 5) hist[gray[i]]++;
  let bg = 255;
  for (let v = 255, best = -1; v >= 0; v--) if (hist[v] > best) { best = hist[v]; bg = v; }
  return Math.max(otsu(gray), Math.min(220, bg - 40));
}

// 줄이 수평일 때 가로 띠별 잉크 합의 고저가 가장 뚜렷하다 — 각도를 바꿔 가며 가장 뚜렷한 각도를 찾는다(도 단위, 오른쪽이 내려가면 +)
export function estimateSkew(gray, W, H, th = otsu(gray)) {
  const step = Math.max(2, Math.round(Math.max(W, H) / 900));
  const pts = [];
  for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) if (gray[y * W + x] < th) pts.push(x, y);
  if (pts.length < 2000) return 0;
  const bin = Math.max(2, Math.round(H / 900));
  const nb = Math.ceil((H + W * 0.12) / bin) + 2;
  const off = W * 0.06;
  const score = (deg) => {
    const t = Math.tan((deg * Math.PI) / 180);
    const bins = new Int32Array(nb);
    for (let i = 0; i < pts.length; i += 2) {
      const k = Math.floor((pts[i + 1] - pts[i] * t + off) / bin);
      if (k >= 0 && k < nb) bins[k]++;
    }
    let s = 0;
    for (let i = 0; i < nb; i++) s += bins[i] * bins[i];
    return s;
  };
  let best = 0, top = score(0);
  const flat = top;
  for (let d = -3; d <= 3.001; d += 0.25) {
    const s = score(d);
    if (s > top) { top = s; best = d; }
  }
  for (let d = best - 0.2; d <= best + 0.2001; d += 0.05) {
    const s = score(d);
    if (s > top) { top = s; best = d; }
  }
  // 끝자락 각도나 거의 차이 없는 값은 믿지 않는다(사진·글이 적은 쪽)
  if (Math.abs(best) > 2.9 || top < flat * 1.02) return 0;
  return Math.abs(best) < 0.1 ? 0 : +best.toFixed(2);
}

// 기울어진 그림을 바로 세운다(같은 크기, 비는 곳은 흰색)
export function rotateGray(gray, W, H, deg) {
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const cx = W / 2, cy = H / 2;
  const out = new Uint8Array(W * H).fill(255);
  let o = 0;
  for (let y = 0; y < H; y++) {
    const dy = y - cy;
    for (let x = 0; x < W; x++, o++) {
      const dx = x - cx;
      const sx = cx + dx * c - dy * s, sy = cy + dx * s + dy * c;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 >= W - 1 || y0 >= H - 1) continue;
      const fx = sx - x0, fy = sy - y0;
      const i = y0 * W + x0;
      const a = gray[i] + (gray[i + 1] - gray[i]) * fx;
      const b = gray[i + W] + (gray[i + W + 1] - gray[i + W]) * fx;
      out[o] = a + (b - a) * fy;
    }
  }
  return out;
}

// 바로 세운 쪽의 네모 → 원본 쪽의 네모(쪽 단위) — 그림은 원본에서 오리므로
export function unskewRect(r, deg, w, h) {
  if (!deg) return r;
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const cx = w / 2, cy = h / 2;
  const xs = [], ys = [];
  for (const [x, y] of [[r.x0, r.y0], [r.x1, r.y0], [r.x0, r.y1], [r.x1, r.y1]]) {
    xs.push(cx + (x - cx) * c - (y - cy) * s);
    ys.push(cy + (x - cx) * s + (y - cy) * c);
  }
  return { x0: Math.max(0, Math.min(...xs)), y0: Math.max(0, Math.min(...ys)), x1: Math.min(w, Math.max(...xs)), y1: Math.min(h, Math.max(...ys)) };
}

// 잉크 격자(칸마다 잉크 화소 수)
function inkGrid(gray, W, H, cell, th) {
  const nx = Math.ceil(W / cell), ny = Math.ceil(H / cell);
  const count = new Uint16Array(nx * ny);
  for (let y = 0, i = 0; y < H; y++) {
    const cy = Math.floor(y / cell) * nx;
    for (let x = 0; x < W; x++, i++) if (gray[i] < th) count[cy + Math.floor(x / cell)]++;
  }
  return { nx, ny, count };
}

// 글자 줄보다 키가 큰 빽빽한 덩어리 = 사진. 인식기에 넘기지 않는다(헛글자가 나오고 오래 걸린다)
function findPhotos(occ, nx, ny, cellPt, scale) {
  const tall = Math.round(22 / cellPt);
  const open = new Uint8Array(nx * ny);
  for (let x = 0; x < nx; x++) {
    let run = 0;
    for (let y = 0; y <= ny; y++) {
      if (y < ny && occ[y * nx + x]) { run++; continue; }
      if (run >= tall) for (let k = y - run; k < y; k++) open[k * nx + x] = 1;
      run = 0;
    }
  }
  const out = [];
  for (const c of components(open, nx, ny, 1)) {
    const w = (c.x1 - c.x0 + 1) * cellPt, h = (c.y1 - c.y0 + 1) * cellPt;
    if (w < 36 || h < 36) continue;
    if (c.n / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)) < 0.5) continue;
    out.push({ x0: c.x0 * cellPt * scale, y0: c.y0 * cellPt * scale, x1: (c.x1 + 1) * cellPt * scale, y1: (c.y1 + 1) * cellPt * scale });
  }
  return out;
}

// 켜진 칸 덩어리들(reach 칸까지 떨어진 것은 한 덩어리) → [{x0,y0,x1,y1,n}] (칸 단위, n: 켜진 칸 수)
function components(mask, nx, ny, reach) {
  const dil = reach ? new Uint8Array(nx * ny) : mask;
  if (reach) {
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      if (!mask[y * nx + x]) continue;
      for (let j = Math.max(0, y - reach); j <= Math.min(ny - 1, y + reach); j++) dil.fill(1, j * nx + Math.max(0, x - reach), j * nx + Math.min(nx - 1, x + reach) + 1);
    }
  }
  const label = new Int32Array(nx * ny).fill(-1);
  const out = [];
  const stack = [];
  for (let k = 0; k < dil.length; k++) {
    if (!dil[k] || label[k] >= 0) continue;
    const id = out.length;
    const c = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, n: 0 };
    out.push(c);
    label[k] = id;
    stack.push(k);
    while (stack.length) {
      const q = stack.pop();
      const y = Math.floor(q / nx), x = q - y * nx;
      if (mask[q]) {
        c.n++;
        if (x < c.x0) c.x0 = x;
        if (x > c.x1) c.x1 = x;
        if (y < c.y0) c.y0 = y;
        if (y > c.y1) c.y1 = y;
      }
      if (x > 0 && dil[q - 1] && label[q - 1] < 0) { label[q - 1] = id; stack.push(q - 1); }
      if (x < nx - 1 && dil[q + 1] && label[q + 1] < 0) { label[q + 1] = id; stack.push(q + 1); }
      if (y > 0 && dil[q - nx] && label[q - nx] < 0) { label[q - nx] = id; stack.push(q - nx); }
      if (y < ny - 1 && dil[q + nx] && label[q + nx] < 0) { label[q + nx] = id; stack.push(q + nx); }
    }
  }
  return out.filter((c) => c.n);
}

// 표 선이 지나는 칸을 지운다
function clearRules(mask, nx, ny, cellPx, rules, scale) {
  for (const r of rules) {
    if (r.h) {
      const y = Math.min(ny - 1, Math.max(0, Math.floor((r.y * scale) / cellPx)));
      const a = Math.max(0, Math.floor((r.a * scale) / cellPx)), b = Math.min(nx - 1, Math.floor((r.b * scale) / cellPx));
      for (let k = Math.max(0, y - 1); k <= Math.min(ny - 1, y + 1); k++) mask.fill(0, k * nx + a, k * nx + b + 1);
    } else {
      const x = Math.min(nx - 1, Math.max(0, Math.floor((r.x * scale) / cellPx)));
      const a = Math.max(0, Math.floor((r.a * scale) / cellPx)), b = Math.min(ny - 1, Math.floor((r.b * scale) / cellPx));
      for (let k = a; k <= b; k++) for (let j = Math.max(0, x - 1); j <= Math.min(nx - 1, x + 1); j++) mask[k * nx + j] = 0;
    }
  }
}

// 쪽을 인식기가 통째로 읽을 덩어리로 나눈다. 인식기는 가로로 이어진 줄을 한 줄로 읽으므로 단을 먼저 갈라 준다
// (인식기 자체의 쪽 분석은 2단은 잘 가르지만 보통 쪽의 글을 세로글로 잘못 보고 잃어버렸다 — 실측 372낱말 → 257낱말).
// 돌려주는 것: { regions: [{x0,y0,x1,y1}](픽셀), photos: [...](픽셀), rules(쪽 단위) }
export function pageRegions(gray, W, H, scale) {
  const th = inkThreshold(gray);
  const rules = rulesFromGray(gray, W, H, scale);
  const cellPt = 2;
  const cell = Math.max(3, Math.round(cellPt * scale));
  const realPt = cell / scale;
  const { nx, ny, count } = inkGrid(gray, W, H, cell, th);
  const min = Math.max(2, Math.round(cell * cell * 0.08));
  const occ = new Uint8Array(nx * ny);
  for (let i = 0; i < occ.length; i++) if (count[i] >= min) occ[i] = 1;
  const photos = findPhotos(occ, nx, ny, realPt, scale);
  for (const p of photos) {
    const x0 = Math.floor(p.x0 / cell), x1 = Math.min(nx, Math.ceil(p.x1 / cell));
    for (let y = Math.floor(p.y0 / cell); y < Math.min(ny, Math.ceil(p.y1 / cell)); y++) occ.fill(0, y * nx + x0, y * nx + x1);
  }
  clearRules(occ, nx, ny, cell, rules, scale);
  // 합계표로 어느 네모든 잉크 칸 수를 바로 센다
  const S = new Int32Array((nx + 1) * (ny + 1));
  for (let y = 0; y < ny; y++) {
    let row = 0;
    for (let x = 0; x < nx; x++) {
      row += occ[y * nx + x];
      S[(y + 1) * (nx + 1) + x + 1] = S[y * (nx + 1) + x + 1] + row;
    }
  }
  const sum = (x0, y0, x1, y1) => S[y1 * (nx + 1) + x1] - S[y0 * (nx + 1) + x1] - S[y1 * (nx + 1) + x0] + S[y0 * (nx + 1) + x0];
  const trim = (r) => {
    let { x0, y0, x1, y1 } = r;
    while (x0 < x1 && !sum(x0, y0, x0 + 1, y1)) x0++;
    while (x1 > x0 && !sum(x1 - 1, y0, x1, y1)) x1--;
    while (y0 < y1 && !sum(x0, y0, x1, y0 + 1)) y0++;
    while (y1 > y0 && !sum(x0, y1 - 1, x1, y1)) y1--;
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
  };
  // 온 쪽의 가로 빈 틈 — 줄 사이보다 넓은 틈에서만 위아래로 가른다
  const rowGaps = [];
  for (let y = 0, run = 0; y <= ny; y++) {
    if (y < ny && !sum(0, y, nx, y + 1)) { run++; continue; }
    if (run) rowGaps.push(run);
    run = 0;
  }
  const typical = median(rowGaps.filter((g) => g * realPt < 40)) || 3;
  const minGapH = Math.max(typical * 1.6, 8 / realPt);
  const pageW = W / scale;
  const minGutter = Math.max(9, pageW * 0.016) / realPt;
  const minCol = (pageW * 0.16) / realPt;
  const minColH = 36 / realPt;
  const noise = (h) => Math.max(0, Math.floor(h * 0.006));
  // 줄(빈 띠로 나뉜 덩어리)마다 잉크가 단 폭을 얼마나 채우나(가운뎃값) — 글줄은 차 있고, 짧은 칸이 띄엄띄엄 놓인 표는 비어 있다
  const fillOf = (r0) => {
    const r = trim(r0);
    if (!r) return 0;
    const fills = [];
    for (let y = r.y0, start = -1; y <= r.y1; y++) {
      if (y < r.y1 && sum(r.x0, y, r.x1, y + 1)) { if (start < 0) start = y; continue; }
      if (start < 0) continue;
      let a = r.x0, b = r.x1;
      while (a < b && !sum(a, start, a + 1, y)) a++;
      while (b > a && !sum(b - 1, start, b, y)) b--;
      fills.push((b - a) / (r.x1 - r.x0));
      start = -1;
    }
    return median(fills);
  };
  const gutter = (r) => {
    const h = r.y1 - r.y0;
    if (h < minColH) return null;
    let best = null;
    for (let x = r.x0, start = -1; x <= r.x1; x++) {
      const empty = x < r.x1 && sum(x, r.y0, x + 1, r.y1) <= noise(h);
      if (empty) { if (start < 0) start = x; continue; }
      if (start >= 0) {
        const w = x - start;
        if (w >= minGutter && start - r.x0 >= minCol && r.x1 - x >= minCol && (!best || w > best.w)) {
          const fl = fillOf({ ...r, x1: start }), fr = fillOf({ ...r, x0: x });
          if (Math.max(fl, fr) >= 0.6 && Math.min(fl, fr) >= 0.35) best = { x: start, w };
        }
        start = -1;
      }
    }
    return best;
  };
  const widestGap = (r) => {
    let best = null;
    for (let y = r.y0, start = -1; y <= r.y1; y++) {
      const empty = y < r.y1 && !sum(r.x0, y, r.x1, y + 1);
      if (empty) { if (start < 0) start = y; continue; }
      if (start >= 0) {
        const g = y - start;
        if (g >= minGapH && (!best || g > best.h)) best = { y: start, h: g };
        start = -1;
      }
    }
    return best;
  };
  const cut = (r0, depth) => {
    const r = trim(r0);
    if (!r) return [];
    if (depth > 14) return [r];
    const g = gutter(r);
    if (g) return [...cut({ ...r, x1: g.x }, depth + 1), ...cut({ ...r, x0: g.x + g.w }, depth + 1)];
    const gap = widestGap(r);
    if (!gap) return [r];
    const top = cut({ ...r, y1: gap.y }, depth + 1), bot = cut({ ...r, y0: gap.y + gap.h }, depth + 1);
    return top.length <= 1 && bot.length <= 1 ? [r] : [...top, ...bot];
  };
  const pad = Math.round(cell * 1.5);
  const regions = cut({ x0: 0, y0: 0, x1: nx, y1: ny }, 0).map((r) => ({
    x0: Math.max(0, r.x0 * cell - pad), y0: Math.max(0, r.y0 * cell - pad), x1: Math.min(W, r.x1 * cell + pad), y1: Math.min(H, r.y1 * cell + pad),
  })).filter((r) => r.x1 - r.x0 >= 24 && r.y1 - r.y0 >= 14);
  return { regions, photos, rules };
}

// 네모 자리만 잘라 인식기에 넘길 그림으로(사진 자리는 하얗게)
export function cropForOcr(gray, W, H, r, photos = []) {
  const w = r.x1 - r.x0, h = r.y1 - r.y0;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) out.set(gray.subarray((r.y0 + y) * W + r.x0, (r.y0 + y) * W + r.x0 + w), y * w);
  for (const p of photos) {
    const x0 = Math.max(0, Math.floor(p.x0 - r.x0)), x1 = Math.min(w, Math.ceil(p.x1 - r.x0));
    if (x1 <= x0) continue;
    for (let y = Math.max(0, Math.floor(p.y0 - r.y0)); y < Math.min(h, Math.ceil(p.y1 - r.y0)); y++) out.fill(255, y * w + x0, y * w + x1);
  }
  return { gray: out, w, h };
}

// 줄을 믿을 만한가: 확신도가 아주 낮은 줄(사진·무늬를 글로 잘못 본 것)과 한두 글자 잡티는 버린다. 숫자뿐인 줄(쪽 번호)은 둔다
const MIN_LINE = 45, MIN_WORD = 25;
export const MIN_PAGE = 62; // 쪽 전체 확신도가 이보다 낮으면 글을 믿지 않는다(실측: 제대로 읽힌 쪽 82~94, 옆으로 누운 쪽·그리스어 잡지 29~50)
function lineStat(ws) {
  const text = ws.map((w) => w[0]).join('');
  const n = Math.max(1, [...text].length);
  const conf = ws.reduce((s, w) => s + w[5] * [...w[0]].length, 0) / n;
  return { text, n, conf };
}
function lineOk({ text, conf }) {
  if (conf < MIN_LINE) return false;
  const bare = text.replace(/[\s.,·:;'"`‘’“”()\-–—~|_]/g, '');
  return !([...bare].length <= 2 && !/^\d+$/.test(bare) && conf < 85);
}

// 글자로 읽히지 않은 잉크 덩어리 = 그림·도표 자리(쪽 단위). 글 줄 자리와 표 선은 뺀다
function figuresFromGray(gray, W, H, scale, lines, rules) {
  const cell = Math.max(3, Math.round(3 * scale));
  const realPt = cell / scale;
  const th = inkThreshold(gray);
  const { nx, ny, count } = inkGrid(gray, W, H, cell, th);
  const min = Math.max(2, Math.round(cell * cell * 0.06));
  const free = new Uint8Array(nx * ny);
  // 쪽 가장자리의 스캔 그림자는 보지 않는다
  const edgeX = Math.ceil(nx * 0.015), edgeY = Math.ceil(ny * 0.012);
  for (let y = edgeY; y < ny - edgeY; y++) for (let x = edgeX; x < nx - edgeX; x++) if (count[y * nx + x] >= min) free[y * nx + x] = 1;
  for (const L of lines) {
    if (!lineOk(lineStat(L.ws))) continue;
    for (const w of L.ws) {
      const m = Math.round((w[4] - w[2]) * 0.2);
      const x0 = Math.max(0, Math.floor((w[1] - m) / cell)), x1 = Math.min(nx - 1, Math.floor((w[3] + m) / cell));
      for (let y = Math.max(0, Math.floor((w[2] - m) / cell)); y <= Math.min(ny - 1, Math.floor((w[4] + m) / cell)); y++) free.fill(0, y * nx + x0, y * nx + x1 + 1);
    }
  }
  clearRules(free, nx, ny, cell, rules, scale);
  const shapes = [];
  for (const c of components(free, nx, ny, 2)) {
    const w = (c.x1 - c.x0 + 1) * realPt, h = (c.y1 - c.y0 + 1) * realPt;
    if (w < 36 || h < 36) continue;
    if (c.n / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1)) < 0.08) continue;
    shapes.push({ x0: round1(c.x0 * realPt), y0: round1(c.y0 * realPt), x1: round1((c.x1 + 1) * realPt), y1: round1((c.y1 + 1) * realPt), img: true });
  }
  return shapes;
}

const round1 = (v) => Math.round(v * 10) / 10;

// ─── 보관용 쪽 기록 ───
// 인식은 쪽당 몇 초씩 걸리므로 쪽마다 결과를 보관하고, 책은 보관한 것으로 엮는다. 기록은 인식기가 준 것에 가깝게 둔다
// (줄·낱말·상자·확신도) — 글 다듬는 규칙을 고쳐도 다시 인식하지 않게. 그림이 있어야 하는 판단(글머리표 모양·표 선·그림 자리)만 여기서 끝낸다.
// 좌표: 낱말은 그림 픽셀(정수), 표 선·그림 자리는 쪽 단위. rot: 바로 세운 각도(도)
export function recordFromOcr(blocks, { width, height, scale = 1, image, rules = [], regions = [], rot = 0 }) {
  const img = { gray: image.gray, w: image.w, h: image.h, th: otsu(image.gray) };
  const lines = [];
  for (const b of blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        const ws = (l.words || []).filter((w) => w.text && w.text.trim() && w.bbox).map((w) => ({ text: w.text.trim(), bbox: w.bbox, symbols: w.symbols, confidence: w.confidence }));
        if (!ws.length) continue;
        ws.sort((a, c) => a.bbox.x0 - c.bbox.x0);
        fixBullet(ws, img);
        const bl = l.baseline && l.baseline.x1 > l.baseline.x0 ? [l.baseline.x0, l.baseline.y0, l.baseline.x1, l.baseline.y1] : 0;
        lines.push({ b: [l.bbox.x0, l.bbox.y0, l.bbox.x1, l.bbox.y1], bl, ws: ws.map((w) => [w.text, w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1, Math.round(w.confidence)]) });
      }
    }
  }
  return {
    v: 1, w: round1(width), h: round1(height), sc: +scale.toFixed(4), rot, lines,
    regions: regions.map((r) => ({ x0: round1(r.x0 / scale), y0: round1(r.y0 / scale), x1: round1(r.x1 / scale), y1: round1(r.y1 / scale) })),
    rules: rules.map((r) => (r.h ? { h: true, y: round1(r.y), a: round1(r.a), b: round1(r.b) } : { h: false, x: round1(r.x), a: round1(r.a), b: round1(r.b) })),
    shapes: figuresFromGray(image.gray, image.w, image.h, scale, lines, rules),
  };
}

// 줄 첫머리 글머리표: 홀로 선 첫 글자(또는 낱말 첫 글자 뒤가 띄어진 것)의 모양을 화소로 가린다
function fixBullet(ws, img) {
  if (ws.length < 2) return;
  const w0 = ws[0];
  const chars = [...w0.text];
  const sym = w0.symbols;
  const hpx = median(ws.map((w) => w.bbox.y1 - w.bbox.y0));
  const box = chars.length === 1 ? w0.bbox : sym && sym[0] && sym[1] && (sym[1].bbox.x0 - sym[0].bbox.x1) > hpx * 0.2 ? sym[0].bbox : null;
  if (!box || !BULLET_LIKE.test(chars[0])) return;
  const shape = bulletShape(img, box, Math.max(4, hpx / 0.92));
  if (!shape) return;
  if (chars.length === 1) { w0.text = shape; return; }
  ws.splice(0, 1, { text: shape, bbox: { ...box }, confidence: w0.confidence }, { text: w0.text.slice(chars[0].length), bbox: { ...w0.bbox, x0: sym[1].bbox.x0 }, confidence: w0.confidence });
}

// 쪽 전체 확신도(글자 수로 가중)
export function recordConf(rec) {
  let seen = 0, weight = 0;
  for (const L of rec.lines) {
    const s = lineStat(L.ws);
    seen += s.conf * s.n;
    weight += s.n;
  }
  return weight ? seen / weight : 100; // 글자가 없으면(빈 쪽·그림만) 못 읽은 것이 아니다
}

// 쪽 기록 → 배치 분석(pdflayout.js) 입력. 한국어 인식기는 한 낱말을 음절마다 떼어 '경 찰 청'처럼 내놓곤 한다 → 쪽 안 한글 사이 틈을
// '낱말 안'과 '띄어쓰기' 두 무리로 갈라(오츠), 좁은 틈의 한글 조각은 한 낱말로 붙인다.
export function pageFromRecord(rec) {
  const scale = rec.sc, width = rec.w, height = rec.h;
  const lines = [];
  let seen = 0, weight = 0, words = 0;
  for (const L of rec.lines) {
    const stat = lineStat(L.ws);
    seen += stat.conf * stat.n;
    weight += stat.n;
    words += L.ws.length;
    if (!lineOk(stat)) continue;
    const ws = [];
    for (const [t0, x0, y0, x1, y1, c] of L.ws) {
      if (BORDER_WORD.test(t0)) continue;
      if (c < MIN_WORD && [...t0].length <= 2) continue;
      const t = fixOcrText(stripBorders(t0));
      if (t) ws.push({ text: t, bbox: { x0, y0, x1, y1 } });
    }
    if (!ws.length) continue;
    // 줄 글자 크기: 줄 상자의 높이로 잰다 — 인식기가 음절마다 끊으면 낱말 상자는 글자 모양('ㅡ'처럼 납작한 글자)에 따라 들쭉날쭉해
    // 짧은 줄에서 크게 흔들리는데(본문 끝줄이 제목으로 잡혔다), 줄 상자는 한글 줄이면 거의 일정하다(실측 본문 50~53픽셀). 잡티로 줄 상자가 부푼 것은 낱말 높이로 막는다
    const hangul = (stat.text.match(HANGUL) || []).length / stat.n;
    const shape = hangul >= 0.3 ? 1 : /[gjpqy,;()]/.test(stat.text) ? 0.95 : /[A-Zbdfhklt0-9]/.test(stat.text) ? 0.72 : 0.5;
    const heights = ws.map((w) => w.bbox.y1 - w.bbox.y0).sort((a, c) => a - c);
    const wordH = heights[heights.length >> 1];
    const sizePx = Math.max(4, Math.min(L.b[3] - L.b[1], wordH * 1.5) / shape);
    const bl = L.bl ? { x0: L.bl[0], y0: L.bl[1], x1: L.bl[2], y1: L.bl[3] } : null;
    ws.sort((a, c) => a.bbox.x0 - c.bbox.x0);
    lines.push({ ws, sizePx, wordH, hangul: hangul >= 0.3, bl, punct: ONLY_PUNCT.test(ws.map((w) => w.text).join('')), bbox: { x0: L.b[0], y0: L.b[1], x1: L.b[2], y1: L.b[3] } });
  }
  // 큰 글자의 아랫부분을 인식기가 유령 줄로 한 번 더 읽는 일이 있다('글자 인식 시험 문서' 아래 '르 느 므') — 더 큰 줄 안에 거의 들어가는 줄은 버린다
  const inside = (a, b) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > (a.x1 - a.x0) * 0.5 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > (a.y1 - a.y0) * 0.7;
  for (let i = lines.length - 1; i >= 0; i--) {
    const L = lines[i];
    if (!L.punct && lines.some((M) => M !== L && M.bbox.y1 - M.bbox.y0 > (L.bbox.y1 - L.bbox.y0) * 1.15 && inside(L.bbox, M.bbox))) lines.splice(i, 1);
  }
  const pageConf = weight ? seen / weight : 0;
  const base = { w: width, h: height, spaces: [], rotated: [], rules: rec.rules, regions: rec.regions || [], ocr: true, rot: rec.rot || 0 };
  // 쪽 전체가 믿기 어려우면(옆으로 누운 쪽, 한국어·영어가 아닌 글, 손글씨 등) 글을 버리고 쪽 그림으로 둔다
  if (words && pageConf < MIN_PAGE) return { ...base, items: [], rules: [], numeric: [], shapes: [{ x0: 0, y0: 0, x1: width, y1: height, img: true }], conf: pageConf };
  // 같은 크기 글자의 낱말 높이 흔들림을 없앤다(제목 판단·문단 잇기가 흔들리지 않게)
  const pageSize = median(lines.map((L) => L.sizePx));
  const pageWord = median(lines.filter((L) => L.ws.length >= 5).map((L) => L.wordH)) || median(lines.map((L) => L.wordH));
  for (const L of lines) {
    // 줄 상자만 크고 낱말들은 본문 크기인 줄(위 첨자·잡티·괄호로 부푼 줄)도 본문 크기로 — 본문 끝줄·숫자 줄이 제목으로 잡히지 않게
    const wr = L.wordH / pageWord;
    if (Math.abs(L.sizePx / pageSize - 1) < 0.14 || (L.sizePx > pageSize && wr < (L.hangul ? 1.08 : 1.2)) || (!L.hangul && wr > 0.85 && wr < 1.2)) L.sizePx = pageSize;
    L.bottom = median(L.ws.filter((w) => w.bbox.y1 - w.bbox.y0 >= L.sizePx * 0.55).map((w) => w.bbox.y1)) || L.bbox.y1;
  }
  // 쪽 안 한글↔한글 틈(글자 크기 배수)으로 '낱말 안 틈' 문턱
  const gaps = [];
  for (const L of lines) for (let i = 1; i < L.ws.length; i++) {
    const a = L.ws[i - 1], c = L.ws[i];
    if (IS_HANGUL.test(a.text.slice(-1)) && IS_HANGUL.test(c.text[0])) gaps.push((c.bbox.x0 - a.bbox.x1) / L.sizePx);
  }
  const join = splitPoint(gaps, 0.15, 0.6, 0.3);
  // 한글 사이 틈을 띄어 쓸까: 아주 좁으면 붙이고 아주 넓으면 띄운다. 그 사이는 틈 크기와 한국어 띄어쓰기 통계(음절 짝마다 띄어 쓴 비율)를 함께 본다
  const logit = (p) => { const q = Math.min(0.98, Math.max(0.02, p)); return Math.log(q / (1 - q)); };
  const LW = 0.5, GW = 16, MG = 0.25; // 가짜 스캔 56쪽(깨끗한·거친 판)에서 고른 값(DRE)
  const spaced = (left, right, z) => {
    if (z <= 0.1) return false;
    if (z >= join + MG) return true;
    const p = spaceProb(left, right);
    const lang = p == null ? 0 : logit(p) * LW;
    return lang + (z - join) * GW > 0;
  };
  const numeric = numericBlocks(lines, rec.rules || [], scale);
  // 표 선이 흐려 표 네모 밖으로 빠진 숫자 줄 — 표 옆에 붙어 있으면 표로 넣는다(pdflayout)
  const numLines = lines.filter((L) => { const n = L.ws.filter((w) => NUM_TOKEN.test(w.text)).length; return n >= 2 && n >= L.ws.length * 0.4; })
    .map((L) => ({ x0: L.bbox.x0 / scale, y0: L.bbox.y0 / scale, x1: L.bbox.x1 / scale, y1: L.bbox.y1 / scale }));
  const items = [];
  const baseAt = (L, w) => {
    let cx = (w.bbox.x0 + w.bbox.x1) / 2;
    let by = w.bbox.y1;
    // 기준선은 줄 안에서만 쓴다(줄 밖으로 늘리면 기울기 때문에 엉뚱한 높이가 된다)
    if (L.bl) { cx = Math.min(L.bl.x1, Math.max(L.bl.x0, cx)); by = L.bl.y0 + ((L.bl.y1 - L.bl.y0) * (cx - L.bl.x0)) / (L.bl.x1 - L.bl.x0); }
    // 따옴표·쉼표처럼 작은 글자는 상자가 줄 위쪽이나 아래쪽에만 있다 — 줄의 기준선을 그대로 쓴다(상자 아래를 쓰면 다른 줄로 떨어져 나간다)
    if (w.bbox.y1 - w.bbox.y0 < L.sizePx * 0.55) return L.bl ? by : L.bottom;
    if (by < w.bbox.y0 || by > w.bbox.y1 + L.sizePx * 0.3) by = w.bbox.y1; // 기준선이 낱말 상자에서 크게 벗어나면 상자 아래로
    return by;
  };
  const NUL = String.fromCharCode(0);
  for (const L of lines) {
    // 따옴표·쉼표만 있는 줄(작은 문장부호를 따로 한 줄로 본 것)은 가장 가까운 글 줄로 옮긴다
    let host = L;
    if (L.punct) {
      let best = null, bd = Infinity;
      for (const M of lines) {
        if (M === L || M.punct) continue;
        const dy = Math.max(0, M.bbox.y0 - L.bbox.y1, L.bbox.y0 - M.bbox.y1);
        const dx = Math.max(0, M.bbox.x0 - L.bbox.x1, L.bbox.x0 - M.bbox.x1);
        if (dy > M.sizePx * 0.8 || dx > M.sizePx * 3) continue;
        if (dy + dx * 0.2 < bd) { bd = dy + dx * 0.2; best = M; }
      }
      if (!best) continue;
      host = best;
    }
    // 좁은 틈의 한글 조각 붙이기
    const merged = [];
    for (const w of L.ws) {
      const prev = merged[merged.length - 1];
      if (prev && IS_HANGUL.test(prev.text.slice(-1)) && IS_HANGUL.test(w.text[0]) && !spaced(prev.text, w.text, (w.bbox.x0 - prev.bbox.x1) / host.sizePx)) {
        prev.text += w.text;
        prev.bbox = { x0: prev.bbox.x0, y0: Math.min(prev.bbox.y0, w.bbox.y0), x1: w.bbox.x1, y1: Math.max(prev.bbox.y1, w.bbox.y1) };
        continue;
      }
      merged.push({ text: w.text, bbox: { ...w.bbox } });
    }
    // 따옴표 방향: 홀로 선 따옴표는 더 가까운 쪽 낱말에 붙는 것으로 본다
    merged.forEach((w, i) => {
      if (!/['"`]/.test(w.text)) return;
      let open = true;
      if (/^['"`]$/.test(w.text)) {
        const gp = i > 0 ? w.bbox.x0 - merged[i - 1].bbox.x1 : Infinity;
        const gn = i + 1 < merged.length ? merged[i + 1].bbox.x0 - w.bbox.x1 : Infinity;
        open = gn < gp;
      }
      w.text = smartQuotes(w.text, open);
    });
    // 괄호 짝(줄 안에서)
    const fixed = fixPairs(merged.map((w) => w.text).join(NUL)).split(NUL);
    merged.forEach((w, i) => { w.text = fixed[i] ?? w.text; });
    for (const w of merged) {
      const y = L === host ? baseAt(L, w) : baseAt(host, { bbox: { x0: w.bbox.x0, x1: w.bbox.x1, y0: host.bbox.y0, y1: host.bbox.y1 } });
      items.push({ s: w.text, x0: w.bbox.x0 / scale, x1: w.bbox.x1 / scale, y: y / scale, size: host.sizePx / scale, font: 'ocr', fixed: false, ocr: true });
    }
  }
  return { ...base, items, numeric, numLines, shapes: rec.shapes || [], conf: pageConf };
}

// 세로줄 없는 숫자 표(숫자가 대부분인 줄이 여럿 이어진 곳): 숫자를 잘못 읽을 수 있고 글로 흘리면 칸이 무너진다 — 선 있는 표처럼 원본 모양으로 둔다(쪽 단위 네모)
const NUM_TOKEN = /^[[(|]?[-+−]?\d[\d.,:–-]*[\])|%]*$/;
function numericBlocks(lines, rules, scale) {
  const isNum = (L) => {
    const n = L.ws.filter((w) => NUM_TOKEN.test(w.text)).length;
    return n >= 3 && n >= L.ws.length * 0.5;
  };
  const sorted = [...lines].sort((a, b) => a.bbox.y0 - b.bbox.y0);
  const out = [];
  let cur = null;
  const close = () => { if (cur && cur.nums >= 3) out.push(cur); cur = null; };
  for (const L of sorted) {
    const h = L.bbox.y1 - L.bbox.y0;
    const near = cur && L.bbox.y0 - cur.y1 < h * 2.2 && L.bbox.x0 < cur.x1 && L.bbox.x1 > cur.x0;
    if (isNum(L)) {
      if (!near) { close(); cur = { x0: L.bbox.x0, x1: L.bbox.x1, y0: L.bbox.y0, y1: L.bbox.y1, nums: 0 }; }
      cur.nums++;
    } else if (!near || L.ws.length > 8) { // 사이에 낀 행 이름은 함께, 긴 글줄이 나오면 끝
      close();
      continue;
    }
    cur.x0 = Math.min(cur.x0, L.bbox.x0); cur.x1 = Math.max(cur.x1, L.bbox.x1); cur.y1 = Math.max(cur.y1, L.bbox.y1);
  }
  close();
  return out.map((b) => {
    const r = { x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale };
    // 위아래 가로줄까지 넓힌다(머리 칸이 함께 들어오게) — 사이에 긴 글줄이 없을 때만
    const prose = (y0, y1) => lines.some((L) => L.ws.length > 8 && !isNum(L) && L.bbox.y0 / scale > y0 && L.bbox.y1 / scale < y1 && L.bbox.x0 / scale < r.x1 && L.bbox.x1 / scale > r.x0);
    for (const R of rules) {
      if (!R.h || R.a > r.x1 || R.b < r.x0) continue;
      if (R.y < r.y0 && r.y0 - R.y < 110 && !prose(R.y, r.y0)) r.y0 = R.y;
      if (R.y > r.y1 && R.y - r.y1 < 40 && !prose(r.y1, R.y)) r.y1 = R.y;
    }
    for (const R of rules) if (R.h && R.y >= r.y0 - 1 && R.y <= r.y1 + 1) { r.x0 = Math.min(r.x0, R.a); r.x1 = Math.max(r.x1, R.b); }
    return r;
  });
}
