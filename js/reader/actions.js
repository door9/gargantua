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
  menu(anchor, keys.map((k) => ({
    label: LOOKUPS[k].label,
    icon: 'external',
    onClick: () => window.open(LOOKUPS[k].url(q), '_blank', 'noopener'),
  })), { title: `“${q.length > 24 ? `${q.slice(0, 24)}…` : q}” 찾아보기` });
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
