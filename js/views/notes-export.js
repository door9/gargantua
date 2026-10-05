// 노트(하이라이트·메모) → Markdown
const COLOR_NAMES = ['노랑', '민트', '분홍', '파랑'];

export function exportNotesMarkdown(groups) {
  const lines = [];
  const stamp = new Date().toLocaleString('ko-KR');
  lines.push(`# Gargantua 노트`, '', `> ${stamp} 내보냄`, '');
  for (const { doc, anns, where } of groups) {
    if (!anns.length) continue;
    lines.push(`## ${doc.title}${doc.author ? ` — ${doc.author}` : ''}`, '');
    for (const a of anns) {
      const quote = (a.anchor?.quote || '').replace(/\s+/g, ' ').trim();
      lines.push(`> ${quote}`);
      const meta = [where?.(a), COLOR_NAMES[a.color || 0], new Date(a.createdAt || Date.now()).toLocaleDateString('ko-KR')].filter(Boolean).join(' · ');
      lines.push(`> <small>${meta}</small>`);
      if (a.note) {
        lines.push('');
        for (const l of a.note.split('\n')) lines.push(l);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
