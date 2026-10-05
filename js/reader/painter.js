// 하이라이트 칠하기 — 글을 건드리지 않는 CSS Highlight 기능을 쓴다(글자 위치가 흔들리지 않음)
export const HL_SUPPORTED = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

export const HL_NAMES = ['g-hl-0', 'g-hl-1', 'g-hl-2', 'g-hl-3'];

export class Painter {
  constructor() {
    this.sets = new Map();
    this.byKey = new Map();
  }

  set(name) {
    if (!HL_SUPPORTED) return null;
    let hl = this.sets.get(name);
    if (!hl) {
      hl = new Highlight();
      if (name.startsWith('g-find')) hl.priority = 2;
      if (name === 'g-flash') hl.priority = 3;
      CSS.highlights.set(name, hl);
      this.sets.set(name, hl);
    }
    return hl;
  }

  add(key, name, range) {
    if (!range) return;
    this.remove(key);
    const hl = this.set(name);
    if (hl) hl.add(range);
    this.byKey.set(key, { name, range });
  }

  remove(key) {
    const prev = this.byKey.get(key);
    if (!prev) return;
    this.sets.get(prev.name)?.delete(prev.range);
    this.byKey.delete(key);
  }

  removeWhere(pred) {
    for (const key of [...this.byKey.keys()]) if (pred(key)) this.remove(key);
  }

  clearName(name) {
    this.sets.get(name)?.clear();
    for (const [key, v] of [...this.byKey]) if (v.name === name) this.byKey.delete(key);
  }

  destroy() {
    for (const [name, hl] of this.sets) {
      hl.clear();
      if (HL_SUPPORTED && CSS.highlights.get(name) === hl) CSS.highlights.delete(name);
    }
    this.sets.clear();
    this.byKey.clear();
  }
}
