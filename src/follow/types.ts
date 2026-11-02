/** 추적 단위: 새 음이 하나 이상 시작되는 악보상의 한 지점. */
export interface ScoreEvent {
  /** 이 지점에서 새로 시작되는 음들 (MIDI 번호). */
  notes: number[];
  /** 이전부터 계속 울리고 있는 음들 (MIDI 번호). */
  held: number[];
  /** 다음 이벤트까지의 길이 (4분음표 = 1). */
  beats: number;
  /** 악보상 마디 번호 (화면 표시용). */
  measure: number;
  /** OSMD 커서를 처음부터 몇 번 next() 해야 이 지점인지. */
  cursorStep: number;
  /** 악보에 적힌 이 지점의 빠르기 (♩/분). 빠르기 표시가 없는 악보면 없음. */
  bpm?: number;
}

export interface FollowState {
  /** 현재 이벤트 인덱스. 아직 시작 전이면 -1. */
  index: number;
  /** 0..1 추적 확신도. */
  confidence: number;
  /** 연주자의 현재 추정 템포 (BPM, 4분음표 기준). */
  bpm: number;
  /** 이번 프레임에 소리가 감지되었는지. */
  voiced: boolean;
}
