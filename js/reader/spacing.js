// 띄어쓰기 고치기 창 — 고른 글의 글자 사이를 눌러 띄우거나 붙인다(기록·입히기는 fixes.js, 적용은 reader/index.js applyFixChange).
// 띄어 쓰는 경우가 많은 자리(PDF 줄 잇기에 쓰는 음절 통계 pdfx/joiner.js spaceProb)는 점선으로 알려만 준다(저절로 고치지 않음).
import { h, esc, toast } from '../util.js';
import { sheet, infoButton } from '../ui/overlay.js';
import { curToOrig, origToCur, fixesOf, fixSig } from '../fixes.js';
import { removeAnn } from '../store.js';
import { toGlobal } from './chapters.js';

const MAX = 120;
const ONE_SPACE = /^[ \t 　]$/;
const HANGUL = /[가-힣]/;
// 이보다 높을 때만 점선으로 알린다 — 실측: 위해|파운 0.80·정도의|통제 0.995·에서|단지 0.84, 붙여 쓰는 매도|했기·투자|자는 0.55
const SUGGEST = 0.7;

let joiner = null;
const loadJoiner = () => (joiner ||= import('../pdfx/joiner.js').catch(() => null));

export async function openSpacing(r, info) {
  const u = info.u;
  const text = r.texts?.[u];
  if (text == null) return;
  const a = info.start;
  const b = info.end;
  if (b - a > MAX) { toast(`띄어쓰기를 고칠 글은 ${MAX}자 안으로 골라 주세요.`); return; }
  const edits = r.fixPlan?.get(u) || [];
  const chars = [];
  for (let i = a; i < b; i++) if (!/\s/.test(text[i])) chars.push(i);
  if (chars.length < 2) { toast('두 글자 넘게 골라 주세요.'); return; }

  // 글자 사이마다: none(붙어 있음)·space(빈칸 하나)·fixed(줄바꿈·빈칸 여럿 — 바꾸지 않음)
  const gaps = [];
  for (let k = 0; k + 1 < chars.length; k++) {
    const p = chars[k];
    const q = chars[k + 1];
    const mid = text.slice(p + 1, q);
    if (!mid) {
      // 붙은 사이 — 원래 빈칸을 뺀 자리면 띄우기 = 그 고침 되돌리기
      const ox = curToOrig(edits, p).o;
      const oy = curToOrig(edits, q).o;
      const del = oy - ox > 1 ? edits.find((e) => e.op === 'del' && e.o > ox && e.o < oy) : null;
      gaps.push({ kind: 'none', was: false, on: false, edited: !!del, at: q, change: del ? { remove: del.ids } : { add: { op: 'ins', o: oy } } });
    } else if (ONE_SPACE.test(mid)) {
      // 빈칸 — 이 앱이 넣은 빈칸이면 붙이기 = 그 고침 되돌리기
      const at = curToOrig(edits, p + 1);
      gaps.push({ kind: 'space', was: true, on: true, edited: !!at.ins, at: q, change: at.ins ? { remove: at.ins.ids } : { add: { op: 'del', o: at.o } } });
    } else {
      gaps.push({ kind: 'fixed', br: mid.includes('\n') });
    }
  }

  const row = h('div');
  const prev = h('div', { class: 'sp-prev', lang: 'ko' });
  const paintGap = (g, el) => {
    el.classList.toggle('on', g.on);
    el.classList.toggle('chg', g.on !== g.was);
    el.classList.toggle('edited', !!g.edited && g.on === g.was);
    el.setAttribute('aria-pressed', g.on ? 'true' : 'false');
    el.setAttribute('aria-label', `${text[chars[gaps.indexOf(g)]]}와 ${text[chars[gaps.indexOf(g) + 1]]} 사이 ${g.on ? '띄움' : '붙임'}`);
  };
  const result = () => {
    let s = text[chars[0]];
    gaps.forEach((g, k) => {
      if (g.kind === 'fixed') s += g.br ? ' ' : text.slice(chars[k] + 1, chars[k + 1]);
      else if (g.on) s += ' ';
      s += text[chars[k + 1]];
    });
    return s;
  };
  const paintPreview = () => {
    const before = text.slice(Math.max(0, a - 14), a).replace(/\s+/g, ' ');
    const after = text.slice(b, b + 14).replace(/\s+/g, ' ');
    prev.innerHTML = `<span class="sp-ctx">${a > 14 ? '…' : ''}${esc(before)}</span><mark>${esc(result())}</mark><span class="sp-ctx">${esc(after)}${b + 14 < text.length ? '…' : ''}</span>`;
  };
  const toggle = (g) => {
    if (!g || g.kind === 'fixed') return;
    g.on = !g.on;
    paintGap(g, g.el);
    paintPreview();
    save.disabled = !gaps.some((x) => x.kind !== 'fixed' && x.on !== x.was);
  };
  chars.forEach((pos, k) => {
    // 글자를 눌러도 가까운 쪽 사이가 바뀐다(손가락에는 사이 단추가 좁다)
    row.append(h('span', {
      class: 'sp-ch',
      onclick: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        toggle(e.clientX > r.left + r.width / 2 ? gaps[k] : gaps[k - 1]);
      },
    }, text[pos]));
    const g = gaps[k];
    if (!g) return;
    if (g.kind === 'fixed') {
      row.append(h('span', { class: `sp-gap fixed${g.br ? ' br' : ''}`, 'aria-hidden': 'true' }));
      return;
    }
    const el = h('button', { class: 'sp-gap', type: 'button', onclick: () => toggle(g) });
    g.el = el;
    paintGap(g, el);
    row.append(el);
  });
  // 글자와 사이 단추를 한 덩어리로(줄이 바뀌어도 사이 단추가 줄 첫머리로 떨어지지 않게)
  const glued = h('div', { class: 'sp-row', lang: 'ko' });
  const nodes = [...row.childNodes];
  for (let i = 0; i < nodes.length; i += 2) {
    glued.append(h('span', { class: 'sp-unit' }, nodes[i], nodes[i + 1] || null));
  }
  paintPreview();

  let save;
  const box = sheet({
    title: '띄어쓰기 고치기',
    className: 'gdialog sp-sheet',
    headerExtra: infoButton('글자 사이를 눌러 띄우거나 붙입니다. V 표시가 띄어 쓴 자리입니다(원고지 띄움표). 점선은 띄어 쓰는 경우가 많은 자리입니다(알려만 주고 저절로 고치지는 않습니다).<br>고친 내용은 이 문서를 펼칠 때 본문에 입혀지고, 원본 파일은 그대로입니다. Dropbox로 다른 기기에도 함께 적용됩니다.<br>고친 곳은 ⋮ 메뉴 \'띄어쓰기 고친 곳\'에서 모아 보고 되돌릴 수 있습니다.'),
    body: h('div', { class: 'sp-body' }, glued, prev),
    actions: [
      { label: '취소' },
      { label: '고치기', primary: true, onClick: async () => {
        const changes = gaps.filter((g) => g.kind !== 'fixed' && g.on !== g.was).map((g) => g.change);
        if (!changes.length) return false;
        await r.applyFixChange(u, changes);
        return false;
      } },
    ],
  });
  save = box.el.querySelector('.gsheet-foot .gbtn.primary');
  save.disabled = true;

  // 띄어 쓰는 경우가 많은 자리 알려 주기(통계 부품은 처음 쓸 때 불러온다)
  const m = await loadJoiner();
  if (!m?.spaceProb || !box.isOpen()) return;
  gaps.forEach((g) => {
    if (g.kind !== 'none' || g.edited) return;
    const left = text.slice(Math.max(0, g.at - 2), g.at);
    const right = text.slice(g.at, g.at + 2);
    if (!HANGUL.test(left.slice(-1)) || !HANGUL.test(right[0])) return;
    const p = m.spaceProb(left, right);
    if (p != null && p >= SUGGEST) g.el.classList.add('sug');
  });
}

// ⋮ '띄어쓰기 고친 곳' — 고친 자리를 글 순서로 모아 보고, 그 자리로 가거나 되돌린다
export function openFixList(r) {
  const body = h('div', { class: 'sp-list' });
  let box = null;
  const fill = () => {
    body.textContent = '';
    const rows = [];
    for (const [s, edits] of r.fixPlan || []) {
      const t = r.texts[s] || '';
      for (const e of edits) {
        // 고친 글에서 그 자리: 넣은 빈칸의 위치 / 뺀 빈칸이 있던 곳(뒤 글자 위치)
        const at = e.op === 'ins' ? origToCur(edits, e.o) - 1 : origToCur(edits, e.o);
        rows.push({ s, e, at, g: toGlobal(r.book, s, at), t });
      }
    }
    rows.sort((x, y) => x.g - y.g);
    const total = fixesOf(r.doc.id);
    const placed = new Set(rows.flatMap((x) => x.e.ids));
    const lost = total.filter((f) => !placed.has(f.id));
    if (!rows.length && !lost.length) {
      body.append(h('p', { class: 'sp-empty' }, '고친 곳이 없습니다.'));
      return;
    }
    for (const x of rows) {
      const before = x.t.slice(Math.max(0, x.at - 12), x.at).replace(/\s+/g, ' ');
      const after = x.t.slice(x.e.op === 'ins' ? x.at + 1 : x.at, (x.e.op === 'ins' ? x.at + 1 : x.at) + 12).replace(/\s+/g, ' ');
      const line = h('div', { class: 'sp-li-text', lang: 'ko' });
      line.innerHTML = `${esc(before)}<span class="sp-mark ${x.e.op}">${x.e.op === 'ins' ? '&nbsp;' : ''}</span>${esc(after)}`;
      body.append(h('div', { class: 'sp-li' },
        h('div', { class: 'sp-li-main' }, h('small', null, x.e.op === 'ins' ? '띄움' : '붙임'), line),
        h('button', { class: 'gbtn small ghost', type: 'button', onclick: () => {
          box?.close();
          r.goToLoc({ s: x.s, o: Math.max(0, x.at - 1), end: x.at + 1 }, { flash: true, divided: true, align: 'center' });
        } }, '보기'),
        h('button', { class: 'gbtn small ghost', type: 'button', onclick: async () => {
          await r.applyFixChange(x.s, [{ remove: x.e.ids }], { announce: false });
          toast('되돌렸습니다.', { duration: 1400 });
          fill();
        } }, '되돌리기')));
    }
    if (lost.length) {
      body.append(h('div', { class: 'sp-lost' },
        h('span', null, `이 원본에서 자리를 찾지 못한 고침 ${lost.length}개`),
        h('button', { class: 'gbtn small ghost', type: 'button', onclick: async () => {
          for (const f of lost) await removeAnn(f.id, { silent: true });
          r.fixSigNow = fixSig(fixesOf(r.doc.id)); // 입힌 것은 그대로다 — 다시 그리지 않게
          toast('찾지 못한 고침을 지웠습니다.', { duration: 1400 });
          fill();
        } }, '지우기')));
    }
  };
  fill();
  box = sheet({ title: '띄어쓰기 고친 곳', className: 'sp-list-sheet', tall: true, body });
}
