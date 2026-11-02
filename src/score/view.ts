import { OpenSheetMusicDisplay, type Cursor, type Note } from 'opensheetmusicdisplay';
import { buildEvents, type RawNote, type RawStep } from '../follow/build';
import type { ScoreEvent } from '../follow/types';

/** OSMD 의 halfTone(옥타브 표기 기준이 다름) → MIDI 번호. */
const HALFTONE_TO_MIDI = 12;

export interface LoadedScore {
  title: string;
  events: ScoreEvent[];
  bpm: number;
  measures: number;
}

interface CursorBox {
  left: number;
  top: number;
  height: number;
}

/**
 * OpenSheetMusicDisplay 로 악보를 그리고,
 * 추적 이벤트 ↔ 악보 커서 위치를 연결한다.
 */
export class ScoreView {
  private readonly container: HTMLElement;
  private osmd: OpenSheetMusicDisplay;
  private events: ScoreEvent[] = [];
  private boxes: CursorBox[] = []; // 이벤트별 커서 위치 (클릭으로 위치 지정용)
  private cursorSteps: number[] = []; // 각 커서가 현재 몇 번째 칸에 있는지
  private shownEvent = -2;
  private zoom = 1;

  constructor(container: HTMLElement, zoom = 1) {
    this.container = container;
    this.zoom = zoom;
    this.osmd = this.createOsmd();
  }

  /** 악보를 지운다. */
  clear(): void {
    this.osmd.clear();
    this.events = [];
    this.boxes = [];
    this.shownEvent = -2;
  }

  private createOsmd(): OpenSheetMusicDisplay {
    return new OpenSheetMusicDisplay(this.container, {
      backend: 'svg',
      autoResize: false, // 크기 변경은 직접 처리 (커서 위치표도 다시 만들어야 해서)
      autoBeam: true,
      drawTitle: true,
      drawSubtitle: true,
      drawComposer: true,
      drawCredits: false,
      drawPartNames: false,
      drawMeasureNumbers: true,
      // 악보의 제목·작곡가·빠르기 글자도 프리텐다드로 (음표 기호는 악보용 글꼴 그대로)
      defaultFontFamily: 'Pretendard Variable, Pretendard, sans-serif',
      followCursor: false,
      cursorsOptions: [
        // 0: 지금 연주 중인 음
        { type: 0, color: '#7e2328', alpha: 0.42, follow: false },
        // 1: 지금 마디
        { type: 3, color: '#c9a86a', alpha: 0.2, follow: false },
      ],
    });
  }

  get eventCount(): number {
    return this.events.length;
  }

  get scoreEvents(): ScoreEvent[] {
    return this.events;
  }

  /** MusicXML 문자열 또는 .mxl Blob 을 읽어 그린다. */
  async load(content: string | Blob, fallbackTitle: string): Promise<LoadedScore> {
    this.osmd.clear();
    this.events = [];
    this.shownEvent = -2;
    // 글꼴이 준비된 뒤에 그려야 글자 폭 계산이 맞는다
    await Promise.all([
      document.fonts.load('400 16px "Pretendard Variable"', '악보가나다ABC'),
      document.fonts.load('700 16px "Pretendard Variable"', '악보가나다ABC'),
    ]).catch(() => undefined);
    await this.osmd.load(content, fallbackTitle);
    this.osmd.Zoom = this.zoom;
    this.osmd.render();
    const steps = this.extractSteps();
    this.events = buildEvents(steps);
    if (this.events.length === 0) throw new Error('이 악보에서 연주할 음표를 찾지 못했습니다.');
    this.recordBoxes();
    this.showEvent(-1);
    const sheet = this.osmd.Sheet;
    const bpm = sheet.HasBPMInfo && sheet.DefaultStartTempoInBpm > 0 ? sheet.DefaultStartTempoInBpm : 100;
    return {
      title: sheet.TitleString || fallbackTitle,
      events: this.events,
      bpm,
      measures: sheet.SourceMeasures.length,
    };
  }

  get loaded(): boolean {
    return this.events.length > 0;
  }

  /** 창 크기가 바뀌거나 확대/축소한 뒤 다시 그린다. */
  setZoom(z: number): void {
    this.zoom = z;
    if (!this.osmd.Sheet || this.events.length === 0) return;
    const keep = this.shownEvent;
    this.osmd.Zoom = z;
    this.osmd.render();
    this.recordBoxes();
    this.shownEvent = -2;
    this.showEvent(keep);
  }

  private get noteCursor(): Cursor {
    return this.osmd.cursors[0];
  }

  /** 커서를 처음부터 끝까지 움직이며 각 칸에서 시작하는 음을 모은다. */
  private extractSteps(): RawStep[] {
    const cursor = this.noteCursor;
    cursor.hide();
    cursor.reset();
    const it = cursor.iterator;
    const steps: RawStep[] = [];
    let step = 0;
    let guard = 0;
    while (!it.EndReached && guard++ < 200000) {
      const onset = it.CurrentEnrolledTimestamp.RealValue * 4;
      const measure = it.CurrentMeasure?.MeasureNumber ?? 0;
      const notes: RawNote[] = [];
      for (const ve of it.CurrentVoiceEntries ?? []) {
        if (ve.IsGrace) continue;
        for (const note of ve.Notes) {
          const raw = toRawNote(note, onset);
          if (raw) notes.push(raw);
        }
      }
      steps.push({ onset, notes, measure, cursorStep: step });
      it.moveToNextVisibleVoiceEntry(false);
      step++;
    }
    cursor.reset();
    return steps;
  }

  /** 각 이벤트의 화면상 커서 위치를 기록한다 (클릭 → 위치 지정). */
  private recordBoxes(): void {
    const cursor = this.noteCursor;
    cursor.show();
    cursor.reset();
    this.boxes = [];
    let step = 0;
    for (const ev of this.events) {
      while (step < ev.cursorStep) {
        cursor.next();
        step++;
      }
      const el = cursor.cursorElement;
      this.boxes.push({ left: el.offsetLeft, top: el.offsetTop, height: el.offsetHeight });
    }
    this.cursorSteps = this.osmd.cursors.map(() => -1);
    this.syncCursors(-1);
  }

  /** 브라우저 화면 좌표에서 가장 가까운 이벤트. */
  eventAtClient(clientX: number, clientY: number): number {
    const parent = this.noteCursor?.cursorElement?.offsetParent as HTMLElement | null;
    if (!parent) return -1;
    const r = parent.getBoundingClientRect();
    return this.eventAt(clientX - r.left + parent.scrollLeft, clientY - r.top + parent.scrollTop);
  }

  /** 커서 기준 좌표에서 가장 가까운 이벤트. */
  private eventAt(x: number, y: number): number {
    let best = -1;
    let bestD = Infinity;
    this.boxes.forEach((b, i) => {
      const inLine = y >= b.top - 10 && y <= b.top + b.height + 10;
      const dy = inLine ? 0 : Math.min(Math.abs(y - b.top), Math.abs(y - b.top - b.height));
      const d = Math.abs(x - b.left) + dy * 4;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  /** 이벤트 위치로 커서를 옮긴다. -1 이면 첫 음 앞(시작 전). */
  showEvent(index: number): void {
    if (index === this.shownEvent || this.events.length === 0) return;
    this.shownEvent = index;
    this.syncCursors(index);
  }

  private syncCursors(index: number): void {
    const target = index < 0 ? 0 : this.events[Math.min(index, this.events.length - 1)].cursorStep;
    this.osmd.cursors.forEach((c, ci) => {
      const cur = this.cursorSteps[ci];
      if (cur >= 0 && target >= cur && target - cur <= 8) {
        for (let k = cur; k < target; k++) c.next();
      } else {
        // 큰 이동: 커서를 숨긴 채 반복자만 옮긴 뒤 한 번에 그린다
        c.hide();
        c.reset();
        for (let k = 0; k < target; k++) c.iterator.moveToNextVisibleVoiceEntry(false);
        c.show();
      }
      this.cursorSteps[ci] = target;
      c.cursorElement.style.opacity = index < 0 ? '0.35' : '1';
    });
  }

  /** 현재 음 커서의 화면상 위치. */
  cursorRect(): DOMRect | null {
    const c = this.noteCursor;
    if (!c || c.hidden || !c.cursorElement || c.cursorElement.style.display === 'none') return null;
    return c.cursorElement.getBoundingClientRect();
  }
}

function toRawNote(note: Note, onset: number): RawNote | null {
  if (note.isRest() || !note.Pitch) return null;
  if (note.IsCueNote || note.IsGraceNote) return null;
  const tie = note.NoteTie;
  if (tie && tie.StartNote !== note) return null; // 붙임줄로 이어진 음은 새로 치지 않는다
  const duration = (tie ? tie.Duration.RealValue : note.Length.RealValue) * 4;
  return { midi: note.halfTone + HALFTONE_TO_MIDI, onset, duration };
}
