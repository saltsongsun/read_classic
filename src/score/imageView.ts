import type { EventGeometry } from './imageLayout';

export interface PageImage {
  blob: Blob;
  width: number;
  height: number;
}

/**
 * 사진/PDF 악보(원본 이미지)를 그대로 보여 주고, 그 위에 지금 줄·마디·음 위치를 겹쳐 그린다.
 */
export class ImageScoreView {
  private readonly container: HTMLElement;
  private pages: HTMLDivElement[] = [];
  private urls: string[] = [];
  private geo: EventGeometry[] = [];
  private shown = -2;
  private zoom = 1;
  private readonly band: HTMLDivElement;
  private readonly measure: HTMLDivElement;
  private readonly marker: HTMLDivElement;
  private ticks: HTMLDivElement[] = [];
  private showTicks = false;

  constructor(container: HTMLElement, zoom = 1) {
    this.container = container;
    this.zoom = zoom;
    this.band = Object.assign(document.createElement('div'), { className: 'ov-system' });
    this.measure = Object.assign(document.createElement('div'), { className: 'ov-measure' });
    this.marker = Object.assign(document.createElement('div'), { className: 'ov-note' });
  }

  get loaded(): boolean {
    return this.geo.length > 0;
  }

  clear(): void {
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls = [];
    this.pages = [];
    this.ticks = [];
    this.geo = [];
    this.shown = -2;
    this.container.replaceChildren();
  }

  async load(pages: PageImage[], geometry: EventGeometry[]): Promise<void> {
    this.clear();
    this.geo = geometry;
    const loads: Promise<void>[] = [];
    pages.forEach((p, i) => {
      const div = document.createElement('div');
      div.className = 'img-page';
      div.dataset.page = String(i);
      div.style.aspectRatio = `${p.width} / ${p.height}`;
      const img = document.createElement('img');
      const url = URL.createObjectURL(p.blob);
      this.urls.push(url);
      img.src = url;
      img.alt = `악보 ${i + 1}쪽`;
      img.draggable = false;
      loads.push(img.decode().catch(() => undefined));
      const ov = document.createElement('div');
      ov.className = 'img-overlay';
      div.append(img, ov);
      this.container.append(div);
      this.pages.push(div);
    });
    this.applyZoom();
    this.drawTicks();
    await Promise.all(loads);
    this.showEvent(-1);
  }

  setZoom(z: number): void {
    this.zoom = z;
    this.applyZoom();
  }

  private applyZoom(): void {
    for (const p of this.pages) p.style.width = `${Math.round(Math.min(2.5, this.zoom) * 100)}%`;
  }

  /** 인식된 음 위치를 작은 눈금으로 보여 준다 (인식이 빠진 줄을 찾기 쉽게). */
  setShowRecognized(on: boolean): void {
    this.showTicks = on;
    this.drawTicks();
  }

  private drawTicks(): void {
    this.ticks.forEach((t) => t.remove());
    this.ticks = [];
    if (!this.showTicks) return;
    for (const g of this.geo) {
      const t = document.createElement('div');
      t.className = 'ov-tick';
      t.style.left = `${g.x * 100}%`;
      t.style.top = `${g.y0 * 100}%`;
      t.style.height = `${(g.y1 - g.y0) * 100}%`;
      this.pages[g.page]?.querySelector('.img-overlay')?.append(t);
      this.ticks.push(t);
    }
  }

  showEvent(index: number): void {
    if (index === this.shown || this.geo.length === 0) return;
    this.shown = index;
    const g = this.geo[Math.max(0, Math.min(this.geo.length - 1, index))];
    const ov = this.pages[g.page]?.querySelector('.img-overlay');
    if (!ov) return;
    const pad = 0.012;
    place(this.band, 0, g.y0 - pad, 1, g.y1 + pad);
    place(this.measure, g.measure.x0, g.y0 - pad, g.measure.x1, g.y1 + pad);
    place(this.marker, g.x - 0.004, g.y0 - pad, g.x + 0.004, g.y1 + pad);
    const idle = index < 0;
    for (const el of [this.band, this.measure, this.marker]) {
      el.classList.toggle('idle', idle);
      if (el.parentElement !== ov) ov.append(el);
    }
  }

  cursorRect(): DOMRect | null {
    if (!this.marker.isConnected) return null;
    return this.band.getBoundingClientRect();
  }

  /** 화면 좌표에서 가장 가까운 음 */
  eventAtClient(clientX: number, clientY: number): number {
    const pageEl = this.pages.find((p) => {
      const r = p.getBoundingClientRect();
      return clientY >= r.top && clientY <= r.bottom && clientX >= r.left && clientX <= r.right;
    });
    if (!pageEl) return -1;
    const page = Number(pageEl.dataset.page);
    const r = pageEl.getBoundingClientRect();
    const nx = (clientX - r.left) / r.width;
    const ny = (clientY - r.top) / r.height;
    let best = -1;
    let bestD = Infinity;
    this.geo.forEach((g, i) => {
      if (g.page !== page) return;
      const dy = ny < g.y0 ? g.y0 - ny : ny > g.y1 ? ny - g.y1 : 0;
      const d = Math.abs(nx - g.x) + dy * 6;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }
}

function place(el: HTMLElement, x0: number, y0: number, x1: number, y1: number): void {
  el.style.left = `${x0 * 100}%`;
  el.style.top = `${y0 * 100}%`;
  el.style.width = `${Math.max(0.002, x1 - x0) * 100}%`;
  el.style.height = `${Math.max(0.002, y1 - y0) * 100}%`;
}
