/**
 * 사용자가 올린 악보를 브라우저(IndexedDB)에 저장한다.
 * IndexedDB 를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 이번 세션 동안만 메모리에 둔다.
 */
export interface StoredScore {
  id: string;
  title: string;
  fileName: string;
  addedAt: number;
  /** MusicXML 텍스트 또는 .mxl(압축) 바이너리 (사진 악보는 빈 값) */
  data: Blob;
  /** 'image' = 사진/PDF 를 인식한 악보 */
  kind?: 'xml' | 'image';
  /** 사진 악보: 쪽별 이미지와 크기, 인식 결과 */
  pages?: Blob[];
  pageSizes?: Array<{ width: number; height: number }>;
  omr?: Array<{ musicxml: string; staffs: number[][] }>;
}

export interface ScoreEntry {
  id: string;
  title: string;
  subtitle: string;
  builtin: boolean;
}

const DB_NAME = 'read-classic';
const STORE = 'scores';

let dbPromise: Promise<IDBDatabase | null> | null = null;
const memory = new Map<string, StoredScore>();

function openDb(): Promise<IDBDatabase | null> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function isPersistent(): Promise<boolean> {
  return (await openDb()) !== null;
}

export async function listScores(): Promise<StoredScore[]> {
  const db = await openDb();
  const all = db ? await tx<StoredScore[]>(db, 'readonly', (s) => s.getAll()) : [...memory.values()];
  return all.sort((a, b) => b.addedAt - a.addedAt);
}

export async function getScore(id: string): Promise<StoredScore | undefined> {
  const db = await openDb();
  if (!db) return memory.get(id);
  return tx<StoredScore | undefined>(db, 'readonly', (s) => s.get(id));
}

export async function putScore(score: StoredScore): Promise<void> {
  const db = await openDb();
  if (!db) {
    memory.set(score.id, score);
    return;
  }
  await tx(db, 'readwrite', (s) => s.put(score));
}

export async function deleteScore(id: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    memory.delete(id);
    return;
  }
  await tx(db, 'readwrite', (s) => s.delete(id));
}

const ACCEPTED = /\.(musicxml|xml|mxl)$/i;

export function isScoreFile(file: File): boolean {
  return ACCEPTED.test(file.name);
}

/** 파일에서 제목을 뽑아 저장한다. */
export async function addScoreFile(file: File): Promise<StoredScore> {
  if (!isScoreFile(file)) {
    throw new Error(`${file.name}: MusicXML(.musicxml, .xml) 또는 .mxl 파일만 열 수 있습니다.`);
  }
  let title = file.name.replace(ACCEPTED, '');
  if (!/\.mxl$/i.test(file.name)) {
    const head = await file.slice(0, 64 * 1024).text();
    const m =
      /<work-title>([^<]+)<\/work-title>/.exec(head) ??
      /<movement-title>([^<]+)<\/movement-title>/.exec(head) ??
      /<credit-words[^>]*>([^<]+)<\/credit-words>/.exec(head);
    if (m) title = decodeEntities(m[1].trim());
  }
  const score: StoredScore = {
    id: `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    fileName: file.name,
    addedAt: Date.now(),
    data: file.slice(0, file.size, file.type || 'application/octet-stream'),
  };
  await putScore(score);
  return score;
}

/** 사진/PDF 를 인식한 악보를 저장한다. */
export async function addImageScore(
  title: string,
  pages: Array<{ blob: Blob; width: number; height: number }>,
  omr: Array<{ musicxml: string; staffs: number[][] }>,
): Promise<StoredScore> {
  const score: StoredScore = {
    id: `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    fileName: `${pages.length}쪽`,
    addedAt: Date.now(),
    data: new Blob([]),
    kind: 'image',
    pages: pages.map((p) => p.blob),
    pageSizes: pages.map((p) => ({ width: p.width, height: p.height })),
    omr,
  };
  await putScore(score);
  return score;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 악보별로 마지막 위치·템포 같은 작은 설정을 기억한다 (실패해도 무방). */
export function loadPrefs<T extends object>(id: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`rc:prefs:${id}`);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

export function savePrefs(id: string, prefs: object): void {
  try {
    localStorage.setItem(`rc:prefs:${id}`, JSON.stringify(prefs));
  } catch {
    /* 저장 공간이 없거나 막혀 있으면 무시 */
  }
}
