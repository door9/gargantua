// 읽기 설정 칸들 — 읽기 화면(그 문서만 바꿈)과 설정 화면(모든 문서의 기본값)이 함께 쓴다.
// kind: 'text'(줄글·전자책 문서) | 'pdf' | 'all'(설정 화면: 전부)
import { h, clamp } from '../util.js';
import { bindNumberWheel } from './numwheel.js';

export function readerSettingsBody({ get, set, reset, resetLabel = '기본값으로', kind = 'text' }) {
  const body = h('div', { class: 'rset' });
  const seg = (label, key, options) => {
    const row = h('div', { class: 'rset-row' }, h('span', { class: 'rset-label' }, label));
    const group = h('div', { class: 'seg', role: 'radiogroup' });
    for (const [value, text] of options) {
      group.append(h('button', {
        class: `seg-btn${get()[key] === value ? ' on' : ''}`, role: 'radio', 'aria-checked': String(get()[key] === value),
        onclick: () => { set({ [key]: value }); render(); },
      }, text));
    }
    row.append(group);
    return row;
  };
  const slider = (label, key, min, max, step, fmt) => {
    const value = get()[key];
    const out = h('button', { type: 'button', class: 'rset-val', 'aria-label': `${label} — 눌러서 굴려 맞추기` }, fmt(value));
    const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
    const apply = (v) => {
      v = +clamp(Math.round(v / step) * step, min, max).toFixed(3);
      input.value = v;
      out.textContent = fmt(v);
      set({ [key]: v });
    };
    input.addEventListener('input', () => apply(parseFloat(input.value)));
    bindNumberWheel(out, { min, max, step, fmt, get: () => get()[key], set: apply });
    return h('div', { class: 'rset-row slider' },
      h('span', { class: 'rset-label' }, label),
      h('button', { class: 'gicon small', 'aria-label': `${label} 줄이기`, html: '−', onclick: () => apply(get()[key] - step) }),
      input,
      h('button', { class: 'gicon small', 'aria-label': `${label} 늘리기`, html: '+', onclick: () => apply(get()[key] + step) }),
      out);
  };
  const toggle = (label, key) => {
    const id = `t-${key}-${kind}`;
    const input = h('input', { type: 'checkbox', id, class: 'switch' });
    input.checked = get()[key] !== false;
    input.addEventListener('change', () => set({ [key]: input.checked }));
    return h('div', { class: 'rset-row' }, h('label', { class: 'rset-label', for: id }, label), input);
  };
  const render = () => {
    body.textContent = '';
    body.append(
      seg('배경', 'palette', [['paper', '종이'], ['sepia', '세피아'], ['night', '야간']]),
      seg('글꼴', 'typeface', [['serif', '명조'], ['sans', '고딕']]),
      slider('글자 크기', 'fontSize', 12, 32, 0.5, (v) => v.toFixed(1)),
      slider('줄 간격', 'lineHeight', 1.2, 2.4, 0.02, (v) => v.toFixed(2)),
      slider('좌우 여백', 'margin', 8, 64, 1, (v) => String(Math.round(v))),
    );
    if (kind !== 'pdf') {
      body.append(
        slider('문단 간격', 'paraGap', 0, 1.6, 0.05, (v) => v.toFixed(2)),
        slider('들여쓰기', 'indent', 0, 2, 0.5, (v) => v.toFixed(1)),
        slider('본문 폭', 'maxWidth', 420, 1200, 10, (v) => String(Math.round(v))),
        seg('정렬', 'align', [['justify', '양쪽'], ['left', '왼쪽']]),
        seg('한글 줄바꿈', 'keepAll', [[false, '글자 단위'], [true, '낱말 단위']]),
        toggle('영어 낱말 하이픈', 'hyphens'),
        h('div', { class: 'rset-sub' }, '전자책 보기'),
        toggle('책 원래 서식', 'bookStyle'),
        seg('두 쪽 펼침', 'spread', [['auto', '자동'], ['on', '항상'], ['off', '안 함']]),
        toggle('쪽 넘김 움직임', 'pageAnim'),
      );
    }
    if (kind === 'all') body.append(h('div', { class: 'rset-sub' }, 'PDF'));
    if (kind !== 'text') body.append(toggle('야간에 PDF 색 반전', 'pdfInvert'));
    body.append(h('div', { class: 'rset-foot' }, h('button', { class: 'gbtn ghost small', onclick: () => { reset(); render(); } }, resetLabel)));
  };
  render();
  return { body, render };
}
