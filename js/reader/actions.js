// 선택한 글로 하는 일: 찾아보기(사전·백과·번역), 인용 복사, 메모 쓰기
import { h, esc } from '../util.js';
import { menu, sheet, infoButton } from '../ui/overlay.js';

const LOOKUPS = {
  koDict: { label: '국어사전', url: (q) => `https://ko.dict.naver.com/#/search?query=${encodeURIComponent(q)}` },
  enDict: { label: '영어사전', url: (q) => `https://en.dict.naver.com/#/search?query=${encodeURIComponent(q)}` },
  hanja: { label: '한자사전', url: (q) => `https://hanja.dict.naver.com/#/search?query=${encodeURIComponent(q)}` },
  wikiKo: { label: '위키백과', url: (q) => `https://ko.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}` },
  wikiEn: { label: 'Wikipedia', url: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}` },
  namu: { label: '나무위키', url: (q) => `https://namu.wiki/Search?q=${encodeURIComponent(q)}` },
  web: { label: '웹 검색', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  papago: { label: '번역(파파고)', url: (q) => `https://papago.naver.com/?sk=auto&tk=ko&st=${encodeURIComponent(q)}` },
};

export function lookupMenu(anchor, text) {
  const q = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!q) return;
  const latin = /[A-Za-z]/.test(q) && !/[가-힣]/.test(q);
  const han = /[一-鿿]/.test(q) && q.length <= 8;
  const short = q.length <= 40;
  const keys = [];
  if (short) {
    if (latin) keys.push('enDict', 'wikiEn');
    else keys.push('koDict');
    if (han) keys.push('hanja');
    if (!latin) keys.push('wikiKo', 'namu');
  }
  keys.push('web', 'papago');
  const items = [];
  if (q.length <= 60) {
    items.push({
      label: '내 서재 전체에서', icon: 'library',
      onClick: () => import('../main.js').then((m) => m.navigate(`#/search?q=${encodeURIComponent(q)}`)),
    }, { divider: true });
  }
  for (const k of keys) {
    items.push({ label: LOOKUPS[k].label, icon: 'external', onClick: () => window.open(LOOKUPS[k].url(q), '_blank', 'noopener') });
  }
  menu(anchor, items, { title: `“${q.length > 24 ? `${q.slice(0, 24)}…` : q}” 찾아보기` });
}

export function citeText(doc, ann, where = '') {
  const quote = (ann.anchor?.quote || '').replace(/\s+/g, ' ').trim();
  const src = [doc.title, doc.author ? `(${doc.author})` : ''].filter(Boolean).join(' ');
  let out = `“${quote}”\n— ${src}${where ? `, ${where}` : ''}`;
  if (ann.note) out += `\n\n메모: ${ann.note}`;
  return out;
}

export function noteEditor({ quote = '', value = '', title = '메모' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const ta = h('textarea', { class: 'gfield note-input', rows: 6, placeholder: '떠오른 생각을 적어 보세요.', maxlength: 20000 });
    ta.value = value;
    const body = h('div', { class: 'note-editor' },
      quote ? h('blockquote', { class: 'gprompt-quote' }, quote.length > 400 ? `${quote.slice(0, 400)}…` : quote) : null,
      ta);
    const info = infoButton('메모에 <b>#태그</b>를 쓰면 노트 화면에서 태그별로 모아 볼 수 있습니다. 저장: <b>Ctrl+Enter</b>.');
    const s = sheet({
      title,
      body,
      className: 'gdialog note-sheet',
      headerExtra: info,
      actions: [
        { label: '취소' },
        { label: '저장', primary: true, onClick: () => { result = ta.value; } },
      ],
      onClose: () => resolve(result),
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        result = ta.value;
        s.close();
      }
    });
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 80);
  });
}

export function tagsOf(note) {
  const out = new Set();
  for (const m of String(note || '').matchAll(/(^|\s)#([\p{L}\p{N}_-]{1,40})/gu)) out.add(m[2]);
  return [...out];
}

export function noteHtml(note) {
  return esc(note).replace(/(^|\s)#([\p{L}\p{N}_-]{1,40})/gu, '$1<span class="tag">#$2</span>').replace(/\n/g, '<br>');
}

// 문장 카드 이미지(사건의 지평선 그림 위에 인용문) — 휴대폰은 공유 창, PC는 파일로 저장
export async function quoteCardBlob(doc, ann, where = '') {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0B0F0D');
  bg.addColorStop(1, '#16110B');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  // 지평선의 빛
  const cx = W / 2;
  const cy = H * 1.42;
  const r = W * 0.95;
  const glow = ctx.createRadialGradient(cx, cy, r * 0.82, cx, cy, r * 1.08);
  glow.addColorStop(0, 'rgba(255,170,70,0)');
  glow.addColorStop(0.83, 'rgba(255,170,70,0.0)');
  glow.addColorStop(0.9, 'rgba(255,190,90,0.55)');
  glow.addColorStop(0.93, 'rgba(255,214,140,0.95)');
  glow.addColorStop(0.97, 'rgba(240,130,40,0.35)');
  glow.addColorStop(1, 'rgba(240,130,40,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0B0F0D';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.86, 0, Math.PI * 2);
  ctx.fill();
  const serif = '"Noto Serif KR", "Noto Serif CJK KR", "Nanum Myeongjo", "AppleMyungjo", "Batang", serif';
  const sans = '"Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif';
  const quote = (ann.anchor?.quote || '').replace(/\s+/g, ' ').trim();
  const maxW = W - 220;
  let size = quote.length > 220 ? 38 : quote.length > 120 ? 46 : quote.length > 60 ? 54 : 62;
  let lines;
  for (;;) {
    ctx.font = `500 ${size}px ${serif}`;
    lines = wrapText(ctx, quote, maxW);
    if (lines.length * size * 1.62 < H * 0.52 || size <= 28) break;
    size -= 4;
  }
  const lh = size * 1.62;
  let y = H * 0.18 + Math.max(0, (H * 0.5 - lines.length * lh) / 2);
  ctx.fillStyle = 'rgba(232,162,90,0.9)';
  ctx.font = `700 ${Math.round(size * 1.6)}px ${serif}`;
  ctx.fillText('“', 104, y - size * 0.35);
  ctx.fillStyle = '#F2EBDC';
  ctx.font = `500 ${size}px ${serif}`;
  for (const line of lines) {
    y += lh;
    ctx.fillText(line, 110, y);
  }
  ctx.fillStyle = 'rgba(242,235,220,0.72)';
  ctx.font = `500 30px ${sans}`;
  const src = `— ${doc.title}${doc.author ? ` · ${doc.author}` : ''}`;
  ctx.fillText(ellipsize(ctx, src, maxW), 110, y + 96);
  if (where) {
    ctx.fillStyle = 'rgba(242,235,220,0.45)';
    ctx.font = `400 24px ${sans}`;
    ctx.fillText(ellipsize(ctx, where, maxW), 110, y + 140);
  }
  ctx.fillStyle = 'rgba(242,235,220,0.55)';
  ctx.font = `800 24px ${sans}`;
  ctx.letterSpacing = '6px';
  ctx.fillText('GARGANTUA', 110, H - 90);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function ellipsize(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

// 낱말 단위로 줄을 나누고, 한 낱말이 너무 길면 글자 단위로
function wrapText(ctx, text, maxW) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const tryLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(tryLine).width <= maxW) { line = tryLine; continue; }
    if (line) lines.push(line);
    if (ctx.measureText(word).width <= maxW) { line = word; continue; }
    line = '';
    for (const ch of word) {
      if (ctx.measureText(line + ch).width > maxW) { lines.push(line); line = ch; } else line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function shareQuoteCard(doc, ann, where = '') {
  const blob = await quoteCardBlob(doc, ann, where);
  if (!blob) return false;
  const name = `Gargantua-${(doc.title || '문장').slice(0, 20)}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ files: [file], title: doc.title });
      return true;
    } catch (e) {
      if (e?.name === 'AbortError') return true;
    }
  }
  const { downloadBlob } = await import('../util.js');
  downloadBlob(blob, name);
  return true;
}
