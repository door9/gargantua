// PDF 도구: pdf.js 불러오기, 기본 정보·표지·쪽별 글 뽑기
const BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
let pdfjsPromise = null;

export function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdfjs/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.mjs`;
      return lib;
    });
  }
  return pdfjsPromise;
}

export async function openPdf(blob) {
  const lib = await pdfjs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const task = lib.getDocument({
    data,
    cMapUrl: `${BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${BASE}standard_fonts/`,
    wasmUrl: `${BASE}wasm/`,
    iccUrl: `${BASE}iccs/`,
    isEvalSupported: false,
    enableXfa: false,
    disableAutoFetch: true,
  });
  return task.promise;
}

// pdf.js 6부터 닫기는 불러오기 작업 쪽에 있다
export function closePdf(pdf) {
  try {
    const p = pdf?.loadingTask?.destroy ? pdf.loadingTask.destroy() : pdf?.destroy?.();
    p?.catch?.(() => {});
  } catch { /* 이미 닫힘 */ }
}

export async function pdfInfo(blob) {
  const pdf = await openPdf(blob);
  try {
    let title = '';
    let author = '';
    try {
      const meta = await pdf.getMetadata();
      title = (meta?.info?.Title || '').trim();
      author = (meta?.info?.Author || '').trim();
    } catch { /* 정보 없음 */ }
    let cover = null;
    try {
      const page = await pdf.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      const scale = Math.min(240 / vp.width, 340 / vp.height);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, canvas, viewport }).promise;
      cover = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      page.cleanup();
    } catch { cover = null; }
    return { pages: pdf.numPages, title, author, cover };
  } finally {
    closePdf(pdf);
  }
}

// 쪽마다 글(글자 위치 계산과 같은 방식: 조각 문자열을 그대로 잇는다)
export async function pdfTexts(pdf, { onProgress, signal } = {}) {
  const out = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    if (signal?.aborted) throw new DOMException('중단', 'AbortError');
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    out.push(tc.items.map((it) => it.str || '').join(''));
    page.cleanup();
    if (onProgress && p % 10 === 0) onProgress(p / pdf.numPages);
  }
  return out;
}

export async function pdfOutline(pdf) {
  let outline = null;
  try { outline = await pdf.getOutline(); } catch { outline = null; }
  if (!outline) return [];
  const out = [];
  const walk = async (items, level) => {
    for (const it of items) {
      let page = null;
      try {
        let dest = it.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest[0]) {
          page = typeof dest[0] === 'number' ? dest[0] + 1 : (await pdf.getPageIndex(dest[0])) + 1;
        }
      } catch { page = null; }
      const title = (it.title || '').replace(/\s+/g, ' ').trim();
      if (title && page) out.push({ title, level, page });
      if (it.items?.length) await walk(it.items, level + 1);
    }
  };
  await walk(outline, 1);
  return out;
}
