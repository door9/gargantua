// 스캔 PDF 글자 인식: 쪽을 그림으로 그려 인식기(tesseract)로 읽고 쪽마다 보관한다.
// 쪽당 몇 초씩 걸리므로 멈춰도 읽은 쪽은 남는다. 인식기 부품(약 7.6MB)은 처음 쓸 때 받아 기기에 보관한다(서비스워커).
import { toGray, toPnm, estimateSkew, rotateGray, pageRegions, cropForOcr, recordFromOcr, recordConf, MIN_PAGE } from '../pdfx/ocr.js';

const BASE = new URL('../../vendor/tesseract/', import.meta.url).href;
const DPI = 200; // 300dpi 는 더 나쁘고 느렸다(DRE 실측)
const MAX_EDGE = 4500;
const SINGLE_BLOCK = '6'; // 나눠 준 덩어리를 통째로 읽게 한다(쪽 나누기는 pageRegions 가 한다)
const LOAD_LIMIT_MS = 180000;
const STOP = Symbol('stop');

// 동시에 읽을 수: 휴대폰은 하나(메모리·발열), 컴퓨터는 코어 수에 맞춰 넷까지
export function laneCount() {
  if (matchMedia('(pointer: coarse)').matches) return 1;
  return Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 3)));
}

async function createLane(onLog) {
  const T = (await import('../../vendor/tesseract/tesseract.esm.min.js')).default;
  const worker = await T.createWorker('kor+eng', 1, {
    workerPath: `${BASE}worker.min.js`, corePath: `${BASE}tesseract-core-simd-lstm.js`, langPath: `${BASE}lang`,
    workerBlobURL: false, cacheMethod: 'none', gzip: true, logger: (m) => onLog?.(m),
  });
  await worker.setParameters({ tessedit_pageseg_mode: SINGLE_BLOCK });
  return worker;
}

async function renderGray(page) {
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(DPI / 72, MAX_EDGE / Math.max(vp1.width, vp1.height));
  const vp = page.getViewport({ scale });
  const W = Math.max(1, Math.ceil(vp.width));
  const H = Math.max(1, Math.ceil(vp.height));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  await page.render({ canvasContext: ctx, canvas, viewport: vp, intent: 'print' }).promise;
  const gray = toGray(ctx.getImageData(0, 0, W, H).data, W, H);
  canvas.width = canvas.height = 0;
  return { gray, W, H, width: vp1.width, height: vp1.height, scale };
}

function shiftBlock(b, dx, dy) {
  const box = (o) => { if (o) { o.x0 += dx; o.x1 += dx; o.y0 += dy; o.y1 += dy; } };
  for (const p of b.paragraphs || []) {
    for (const l of p.lines || []) {
      box(l.bbox);
      if (l.baseline) box(l.baseline);
      for (const w of l.words || []) {
        box(w.bbox);
        for (const s of w.symbols || []) box(s.bbox);
      }
    }
  }
}

// 쪽 하나 읽기 → 보관용 쪽 기록
export async function readPage(pdf, pageNo, worker) {
  const page = await pdf.getPage(pageNo);
  try {
    const img = await renderGray(page);
    const { W, H, width, height, scale } = img;
    const rot = estimateSkew(img.gray, W, H);
    const gray = rot ? rotateGray(img.gray, W, H, rot) : img.gray;
    const { regions, photos, rules } = pageRegions(gray, W, H, scale);
    const blocks = [];
    for (const r of regions) {
      const c = cropForOcr(gray, W, H, r, photos);
      const res = await worker.recognize(toPnm(c.gray, c.w, c.h), {}, { blocks: true, text: false });
      for (const b of res.data.blocks || []) {
        shiftBlock(b, r.x0, r.y0);
        blocks.push(b);
      }
    }
    return recordFromOcr(blocks, { width, height, scale, image: { gray, w: W, h: H }, rules, regions, rot });
  } finally {
    page.cleanup();
  }
}

export class OcrJob {
  // pages: 읽을 쪽 번호(1부터, 이 순서로), onPage(쪽, 기록): 보관, onProgress({ done, total }), onStage(문구)
  // judge: 앞 8쪽을 보고 알아볼 수 없는 문서면 멈춘다(사용자가 이어 하기를 누른 뒤에는 묻지 않고 끝까지)
  constructor({ pdf, pages, onPage, onProgress, onStage, lanes = laneCount(), judge = true }) {
    Object.assign(this, { pdf, onPage, onProgress, onStage, lanes, judge });
    this.queue = [...pages];
    this.total = pages.length;
    this.done = 0;
    this.judged = 0; // 글자가 있는 쪽 수
    this.unclear = 0;
    this.stopped = false;
    this.unreadable = false; // 읽기 시작한 쪽이 거의 다 알아볼 수 없다(한국어·영어가 아닌 글 등)
    this.workers = [];
    this.stopSignal = new Promise((resolve) => { this.fireStop = () => resolve(STOP); });
  }

  stop() {
    this.stopped = true;
    this.fireStop();
  }

  async lane(worker) {
    let fails = 0;
    while (!this.stopped && this.queue.length) {
      const p = this.queue.shift();
      let rec;
      try {
        const work = readPage(this.pdf, p, worker);
        work.catch(() => {}); // 멈춘 뒤에 실패해도 조용히(일꾼을 끝내고 나면 읽던 쪽은 버린다)
        rec = await Promise.race([work, this.stopSignal]);
      } catch (e) {
        console.warn('글자 인식 실패', p, e);
        if (++fails >= 3) throw e;
        continue; // 이 쪽은 다음에 다시
      }
      if (rec === STOP) return;
      fails = 0;
      await this.onPage(p, rec);
      this.done++;
      if (rec.lines.length) this.judged++;
      if (recordConf(rec) < MIN_PAGE) this.unclear++;
      this.onProgress?.({ done: this.done, total: this.total });
      // 앞쪽 대부분을 알아볼 수 없으면 더 읽어도 헛일이다(한국어·영어가 아닌 글, 손글씨 등)
      if (this.judge && this.done === Math.min(8, this.total) && this.unclear >= Math.max(3, this.judged * 0.7)) {
        this.unreadable = true;
        this.stop();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async run() {
    try {
      this.onStage?.('글자 인식 부품 준비 중');
      const load = (async () => {
        // 첫 일꾼이 부품을 받아 보관한 뒤에 나머지를 띄운다(같은 것을 여러 번 받지 않게)
        const first = await createLane((m) => {
          if (m?.status === 'loading language traineddata' && m.progress < 1) this.onStage?.(`글자 인식 부품 받는 중 ${Math.round((m.progress || 0) * 100)}%`);
        });
        this.workers.push(first);
        if (this.stopped) return;
        const rest = await Promise.all(Array.from({ length: Math.max(0, Math.min(this.lanes, this.queue.length) - 1) }, () => createLane()));
        this.workers.push(...rest);
      })();
      let timer;
      const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('부품을 받지 못했습니다')), LOAD_LIMIT_MS); });
      const first = await Promise.race([load, limit, this.stopSignal]).finally(() => clearTimeout(timer));
      if (first === STOP) {
        load.catch(() => {}).finally(() => this.terminate());
        return this.result();
      }
      this.onStage?.('');
      await Promise.all(this.workers.map((w) => this.lane(w)));
      return this.result();
    } finally {
      this.fireStop(); // 한 줄이 실패해 끝났으면 나머지 줄도 멈춘다
      this.terminate();
    }
  }

  result() {
    return { done: this.done, total: this.total, stopped: this.stopped, unreadable: this.unreadable };
  }

  terminate() {
    for (const w of this.workers) w.terminate().catch?.(() => {});
    this.workers = [];
  }
}
