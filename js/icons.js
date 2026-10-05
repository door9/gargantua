// 선 아이콘 모음 — 한 곳에서 그려 두고 ico('이름')으로 꺼내 쓴다(굵기는 CSS .ico 한 곳)
const PATHS = {
  library: '<path d="M4 19.5V5a1 1 0 0 1 1-1h3v16H5a1 1 0 0 1-1-.5Z"/><path d="M8 4h4v16H8"/><path d="m13.5 5.2 3.6-1 4 14.6-3.6 1Z"/>',
  notes: '<path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5"/><path d="M8.5 12.5h7M8.5 16h5"/>',
  review: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5"/><path d="M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5"/><path d="M4 20v-4.5h4.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  import: '<path d="M12 3v12"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  more: '<circle cx="12" cy="5.5" r="1.1"/><circle cx="12" cy="12" r="1.1"/><circle cx="12" cy="18.5" r="1.1"/>',
  toc: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  bookmark: '<path d="M6.5 3.5h11a.5.5 0 0 1 .5.5v16.5l-6-4-6 4V4a.5.5 0 0 1 .5-.5Z"/>',
  bookmarks: '<path d="M8.5 6.5h9a.5.5 0 0 1 .5.5v14l-5-3.4-5 3.4V7a.5.5 0 0 1 .5-.5Z"/><path d="M6 17.5V4a1 1 0 0 1 1-1h9"/>',
  highlight: '<path d="m14.5 4.5 5 5-8.5 8.5H6v-5Z"/><path d="M4 21h16"/><path d="m12 7 5 5"/>',
  note: '<path d="M5 4h14a1 1 0 0 1 1 1v9.5L14.5 20H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M14 20v-5a.5.5 0 0 1 .5-.5H20"/><path d="M8 9h8M8 12.5h5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1.5"/><path d="M4 15.5V5a1 1 0 0 1 1-1h10.5"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 12.5a1 1 0 0 0 1 .9h7a1 1 0 0 0 1-.9l1-12.5"/><path d="M10 11v5.5M14 11v5.5"/>',
  edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z"/><path d="m14 8 2.5 2.5"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.3 9.6 4.5 4.5 0 0 0 7 18.5Z"/>',
  cloudDown: '<path d="M7 18.5h10.5a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.3 9.6 4.5 4.5 0 0 0 7 18.5Z"/><path d="M12 10.5v6"/><path d="m9.5 14 2.5 2.5 2.5-2.5"/>',
  cloudOff: '<path d="M3 3l18 18"/><path d="M9 5.4A6 6 0 0 1 18 10.5a4 4 0 0 1 2.2 6.6"/><path d="M17 18.5H7a4.5 4.5 0 0 1-.7-8.9"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.6 4.5L20 16"/><path d="M20 20v-4h-4"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 16V5"/><path d="M7.5 9.5 12 5l4.5 4.5"/><path d="M5 20h14"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  shuffle: '<path d="M16 4h4v4"/><path d="M4 20 20 4"/><path d="M20 16v4h-4"/><path d="m15 15 5 5"/><path d="M4 4l5 5"/>',
  pages: '<path d="M12 6.5c-2-1.6-4.7-2.2-8-2v13c3.3-.2 6 .4 8 2 2-1.6 4.7-2.2 8-2v-13c-3.3-.2-6 .4-8 2Z"/><path d="M12 6.5v13"/>',
  scroll: '<path d="M6 4h12M6 8.5h12M6 13h12M6 17.5h8"/>',
  type: '<path d="M4 18 8.5 6h1L14 18"/><path d="M5.6 14h6.8"/><path d="M15.5 18l3-7.5h.5l3 7.5"/><path d="M16.4 15.8h4.6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><path d="M12 7.6h.01"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  lookup: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10v14H5.5A1.5 1.5 0 0 0 4 19.5Z"/><path d="M10 4h8.5a1.5 1.5 0 0 1 1.5 1.5V10"/><circle cx="16" cy="15.5" r="3"/><path d="m20.5 20-2.4-2.4"/>',
  quote: '<path d="M9.5 8H6a1 1 0 0 0-1 1v3.5a1 1 0 0 0 1 1h3.5V15c0 1.7-1.2 3-3 3"/><path d="M19 8h-3.5a1 1 0 0 0-1 1v3.5a1 1 0 0 0 1 1H19V15c0 1.7-1.2 3-3 3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  flame: '<path d="M12 21c3.6 0 6-2.4 6-5.8 0-3.9-3.2-6.2-4-9.7-1.7 1.6-2.4 3.4-2.4 5.2-1-.8-1.6-2-1.7-3.3C7.9 9.3 6 11.8 6 15.2 6 18.6 8.4 21 12 21Z"/>',
  chart: '<path d="M4 20h16"/><path d="M7 16.5V11M12 16.5V6.5M17 16.5v-4"/>',
  filter: '<path d="M4 5h16l-6.2 7.5V19l-3.6 1.5v-8Z"/>',
  sort: '<path d="M7 4v16M3.5 16.5 7 20l3.5-3.5"/><path d="M13 6h8M13 11h6M13 16h4"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1"/>',
  list: '<path d="M8.5 6H20M8.5 12H20M8.5 18H20"/><rect x="3.5" y="4.5" width="3" height="3" rx=".6"/><rect x="3.5" y="10.5" width="3" height="3" rx=".6"/><rect x="3.5" y="16.5" width="3" height="3" rx=".6"/>',
  play: '<path d="M7.5 5.2v13.6a.6.6 0 0 0 .9.5l10.7-6.8a.6.6 0 0 0 0-1L8.4 4.7a.6.6 0 0 0-.9.5Z"/>',
  pause: '<path d="M8.5 5v14M15.5 5v14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/><path d="M11 8.2v5.6M8.2 11h5.6"/>',
  zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/><path d="M8.2 11h5.6"/>',
  fitWidth: '<path d="M4 4v16M20 4v16"/><path d="M8 12h8"/><path d="m10.5 9.5-2.5 2.5 2.5 2.5M13.5 9.5l2.5 2.5-2.5 2.5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  tag: '<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1.4 1.4 0 0 1 0 2l-6.6 6.6a1.4 1.4 0 0 1-2 0Z"/><circle cx="8" cy="8" r="1.3"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2"/><path d="M10.5 18.5h3"/>',
  file: '<path d="M6 3h8.5L19 7.5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M14 3v5h5"/>',
  warning: '<path d="M10.3 4.2 2.8 17.5A2 2 0 0 0 4.5 20.5h15a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z"/><path d="M12 9.5v4"/><path d="M12 17h.01"/>',
  star: '<path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8Z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  sparkle: '<path d="M12 3.5c.5 4.3 2.2 6 6.5 6.5-4.3.5-6 2.2-6.5 6.5-.5-4.3-2.2-6-6.5-6.5 4.3-.5 6-2.2 6.5-6.5Z"/><path d="M18.5 15.5c.2 1.6.9 2.3 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.2 2.3-.9 2.5-2.5Z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  speaker: '<path d="M4.5 9.5h3.2L12 5.5v13l-4.3-4H4.5a.5.5 0 0 1-.5-.5V10a.5.5 0 0 1 .5-.5Z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  panel: '<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M14.5 4.5v15"/>',
  expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  dot: '<circle cx="12" cy="12" r="3.5"/>',
};

export function iconSprite() {
  const symbols = Object.entries(PATHS)
    .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">${symbols}</svg>`;
}

export function ico(name, cls = '') {
  return `<svg class="ico${cls ? ' ' + cls : ''}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

export function icoEl(name, cls = '') {
  const tpl = document.createElement('template');
  tpl.innerHTML = ico(name, cls);
  return tpl.content.firstElementChild;
}
