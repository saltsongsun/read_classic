/**
 * 사진·이미지·PDF 악보를 쪽별 JPEG 로 바꾸고, 악보 인식 서버에 보내 MusicXML 을 받는다.
 */
import type { PageImage } from './imageView';

export interface OmrPage {
  musicxml: string;
  /** 줄(시스템)마다 보표 상자 [중심x, 중심y, 너비, 높이] (이미지 크기 비율) */
  staffs: number[][];
}

const MAX_SIDE = 3000;

export function isImageOrPdf(file: File): boolean {
  return /^image\//.test(file.type) || /\.(jpe?g|png|webp|gif|bmp|heic|heif|pdf)$/i.test(file.name) || file.type === 'application/pdf';
}

export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('이미지를 만들지 못했습니다.'))), 'image/jpeg', 0.9),
  );
}

/** 사진·이미지 한 장 → 방향을 바로잡고 너무 크면 줄인 JPEG */
export async function imageToPage(file: Blob): Promise<PageImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('이 이미지 형식은 열 수 없어요. (아이폰 HEIC 사진은 JPEG 로 바꾸거나, 앱의 "사진 찍기"로 찍어 주세요)');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { blob: await canvasToJpeg(canvas), width: canvas.width, height: canvas.height };
}

/** PDF → 쪽별 JPEG (가로 약 2000px) */
export async function pdfToPages(file: Blob, onPage?: (done: number, total: number) => void): Promise<PageImage[]> {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const pages: PageImage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(4, 2000 / base.width) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      pages.push({ blob: await canvasToJpeg(canvas), width: canvas.width, height: canvas.height });
      page.cleanup();
      onPage?.(i, doc.numPages);
    }
  } finally {
    await task.destroy();
  }
  return pages;
}

function api(base: string, path: string): string {
  const b = base.trim().replace(/\/+$/, '');
  return `${b}${path}`;
}

export interface ServerStatus {
  ok: boolean;
  message: string;
  /** 노트북용 앱(이 컴퓨터 안의 서버)으로 실행 중인지 */
  desktop: boolean;
}

/** 노트북용 앱 내려받기 (항상 가장 최근 판) */
export const LAPTOP_APP = {
  page: 'https://github.com/saltsongsun/read_classic/releases/latest',
  windows: 'https://github.com/saltsongsun/read_classic/releases/latest/download/ReadClassic-Windows-Setup.exe',
  mac: 'https://github.com/saltsongsun/read_classic/releases/latest/download/ReadClassic-Mac.dmg',
};

export async function checkServer(base: string): Promise<ServerStatus> {
  try {
    const res = await fetch(api(base, '/api/health'), { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const j = await res.json();
    if (!j.engine) throw new Error('not a recognition server');
    return { ok: true, desktop: !!j.desktop, message: j.desktop ? '사진·PDF 악보를 이 컴퓨터에서 바로 인식해요' : `악보 인식 서버 연결됨 (homr ${j.version ?? ''})`.trim() };
  } catch {
    return {
      ok: false,
      desktop: false,
      message: base.trim()
        ? `악보 인식 서버(${base})에 연결할 수 없어요.`
        : '사진·PDF 악보 인식은 노트북용 앱에서 할 수 있어요. 왼쪽 목록의 "노트북용 앱 받기"를 눌러 설치해 주세요.',
    };
  }
}

export async function recognizePage(base: string, page: PageImage, signal?: AbortSignal): Promise<OmrPage> {
  const form = new FormData();
  form.append('image', page.blob, 'page.jpg');
  const res = await fetch(api(base, '/api/omr'), { method: 'POST', body: form, signal });
  let body: { musicxml?: string; staffs?: number[][]; detail?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* 본문이 JSON 이 아니면 아래에서 처리 */
  }
  if (!res.ok || !body.musicxml) throw new Error(body.detail || `악보 인식에 실패했어요 (${res.status})`);
  return { musicxml: body.musicxml, staffs: body.staffs ?? [] };
}
