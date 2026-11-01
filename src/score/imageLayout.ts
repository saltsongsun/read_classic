/**
 * 사진/PDF 악보 위에 연주 위치를 그리기 위한 좌표 계산.
 *
 * 인식 서버가 주는 정보:
 *   - 줄(시스템)마다 보표 상자 (이미지 크기에 대한 비율)
 *   - MusicXML 의 줄바꿈 표시 → 각 마디가 몇 번째 줄인지
 *   - (새 homr 만) 음표마다 이미지 좌표 imgpos
 * 음표 좌표가 있으면 그걸 쓰고, 없으면 줄 안에서 마디 길이 비율로 가로 위치를 나눈다.
 * 모든 좌표는 페이지 크기에 대한 비율(0..1)로 돌려준다.
 */
import type { ScoreEvent } from '../follow/types';
import type { ParsedMeasure, ParsedScore, ScoreStep } from './musicxml';

export interface PageInfo {
  /** 원본 이미지 픽셀 크기 */
  width: number;
  height: number;
  /** [중심x, 중심y, 너비, 높이] 비율. 위에서 아래 순서 */
  staffs: number[][];
}

export interface Box {
  page: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface EventGeometry {
  page: number;
  /** 지금 음 표시 위치 (가로) */
  x: number;
  /** 줄(시스템) 세로 범위 */
  y0: number;
  y1: number;
  /** 지금 마디 상자 */
  measure: Box;
}

/** 첫 마디 앞의 음자리표·조표 자리 (줄 너비 대비) */
const LEAD_IN = 0.07;

function systemBoxes(page: PageInfo, systemsOnPage: number): Box[] {
  const raw = page.staffs.map(([cx, cy, w, h]) => ({ x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 }));
  raw.sort((a, b) => a.y0 - b.y0);
  if (raw.length === 0 || systemsOnPage === 0) return [];
  // 보표가 줄 수의 배수면 (큰보표가 따로따로 잡힌 경우) 묶는다
  const k = raw.length % systemsOnPage === 0 ? raw.length / systemsOnPage : 1;
  const out: Box[] = [];
  for (let i = 0; i < raw.length; i += k) {
    const g = raw.slice(i, i + k);
    out.push({
      page: 0,
      x0: Math.min(...g.map((b) => b.x0)),
      x1: Math.max(...g.map((b) => b.x1)),
      y0: Math.min(...g.map((b) => b.y0)),
      y1: Math.max(...g.map((b) => b.y1)),
    });
  }
  return out;
}

/**
 * @param score 여러 페이지를 이어 붙인 인식 결과 (combinePages)
 * @param pages 페이지별 이미지 크기와 보표 상자
 */
export function layoutEvents(score: ParsedScore, steps: ScoreStep[], events: ScoreEvent[], pages: PageInfo[]): EventGeometry[] {
  // 페이지별 마디 → 줄 상자
  const measureBox = new Map<number, Box>();
  const byPage = new Map<number, ParsedMeasure[]>();
  for (const m of score.measures) {
    if (!byPage.has(m.page)) byPage.set(m.page, []);
    byPage.get(m.page)!.push(m);
  }
  for (const [pageIndex, measures] of byPage) {
    const page = pages[pageIndex];
    const systems = Math.max(...measures.map((m) => m.system)) + 1;
    let boxes = page ? systemBoxes(page, systems) : [];
    if (boxes.length === 0) {
      // 보표 위치를 모르면 페이지를 줄 수만큼 나눈다
      boxes = Array.from({ length: systems }, (_, i) => ({
        page: pageIndex,
        x0: 0.05,
        x1: 0.95,
        y0: 0.05 + (0.9 * i) / systems,
        y1: 0.05 + (0.9 * (i + 1)) / systems,
      }));
    }
    for (let s = 0; s < systems; s++) {
      const inSystem = measures.filter((m) => m.system === s);
      // 인식된 줄 수가 보표 상자 수와 다르면 가까운 상자를 쓴다
      const box = boxes[Math.min(boxes.length - 1, Math.round((s * boxes.length) / systems))];
      const total = inSystem.reduce((a, m) => a + m.duration, 0) || 1;
      const width = box.x1 - box.x0;
      let x = box.x0 + LEAD_IN * width;
      const usable = width * (1 - LEAD_IN);
      for (const m of inSystem) {
        const w = (usable * m.duration) / total;
        measureBox.set(m.index, { page: pageIndex, x0: x, x1: x + w, y0: box.y0, y1: box.y1 });
        x += w;
      }
    }
  }

  // 음표 좌표가 있으면 마디 상자를 실제 음표 범위로 다듬는다
  const notePos = new Map<number, { x0: number; x1: number }>();
  for (const n of score.notes) {
    if (!n.pos) continue;
    const page = pages[n.page];
    if (!page) continue;
    const x = n.pos.x / page.width;
    const cur = notePos.get(n.measure);
    notePos.set(n.measure, cur ? { x0: Math.min(cur.x0, x), x1: Math.max(cur.x1, x) } : { x0: x, x1: x });
  }
  for (const [m, r] of notePos) {
    const box = measureBox.get(m);
    if (box) {
      box.x0 = r.x0 - 0.02;
      box.x1 = r.x1 + 0.025;
    }
  }

  const measureOnset = new Map(score.measures.map((m) => [m.index, m]));
  return events.map((ev) => {
    const step = steps[ev.cursorStep];
    const box = measureBox.get(ev.measure) ?? { page: 0, x0: 0, x1: 1, y0: 0, y1: 1 };
    let x: number;
    const withPos = step.notes.filter((n) => n.pos);
    if (withPos.length) {
      const page = pages[withPos[0].page];
      x = withPos.reduce((a, n) => a + n.pos!.x, 0) / withPos.length / page.width;
    } else {
      const m = measureOnset.get(ev.measure);
      const f = m && m.duration > 0 ? (step.onset - m.onset) / m.duration : 0;
      x = box.x0 + (0.04 + 0.92 * Math.min(1, Math.max(0, f))) * (box.x1 - box.x0);
    }
    return { page: box.page, x, y0: box.y0, y1: box.y1, measure: box };
  });
}
