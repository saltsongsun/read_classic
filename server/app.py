"""
Read Classic 악보 인식 서버.

사진·스캔한 악보 한 쪽(이미지)을 받아 homr 로 MusicXML 을 만들어 돌려준다.
함께 돌려주는 위치 정보로 앱이 원본 악보 위에 지금 연주 위치를 표시한다.
  - staffs: 줄(시스템)마다 보표 상자 [중심x, 중심y, 너비, 높이] (이미지 크기에 대한 비율)
  - 새 homr 는 음표마다 `<!-- imgpos: x, y -->` 주석도 남긴다 (있으면 앱이 더 정확히 표시)

환경 변수
  HOMR_CMD         homr 실행 명령 (기본: "homr")
  HOMR_WORKER_CMD  homr 를 켜 둔 채 쪽마다 일을 넘기는 작업자 명령 (예: "python -m server.homr_worker").
                   있으면 쪽마다 프로그램을 새로 켜지 않아 빠르다. 작업자가 잘못되면 HOMR_CMD 로 한다.
  OMR_TIMEOUT      한 쪽 인식 제한 시간(초, 기본 600)
  OMR_CONCURRENCY  동시에 인식할 쪽 수 (기본 1; CPU 를 많이 쓴다)
  MAX_UPLOAD_MB    업로드 최대 크기 (기본 25)
  ALLOWED_ORIGINS  다른 주소(예: GitHub Pages)의 앱에서 부를 때 허용할 origin, 쉼표로 구분 (기본 "*")
  STATIC_DIR       함께 서비스할 웹 앱 폴더 (기본: 저장소의 dist/)
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import shlex
import subprocess
import sys
import tempfile
import threading
import time
from importlib import metadata
from pathlib import Path

import mimetypes

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from server.update import current as app_version
from server.update import updater

# 웹 앱 파일 형식: Windows 는 레지스트리 설정에 따라 .mjs·.wasm 을 엉뚱하게 알려 줄 수 있다.
# (PDF 해독 워커·AI 음 인식 실행기는 이 형식이 맞아야 브라우저가 실행한다)
for _ext, _type in ((".mjs", "text/javascript"), (".js", "text/javascript"), (".wasm", "application/wasm"), (".onnx", "application/octet-stream")):
    mimetypes.add_type(_type, _ext)

HOMR_CMD = shlex.split(os.environ.get("HOMR_CMD", "homr"))
HOMR_WORKER_CMD = shlex.split(os.environ["HOMR_WORKER_CMD"]) if os.environ.get("HOMR_WORKER_CMD") else None
OMR_TIMEOUT = float(os.environ.get("OMR_TIMEOUT", "600"))
MAX_UPLOAD = int(float(os.environ.get("MAX_UPLOAD_MB", "25")) * 1024 * 1024)
STATIC_DIR = Path(os.environ.get("STATIC_DIR", Path(__file__).resolve().parent.parent / "dist"))
ALLOWED = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}

app = FastAPI(title="Read Classic OMR", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
_slots = asyncio.Semaphore(max(1, int(os.environ.get("OMR_CONCURRENCY", "1"))))


def _engine_version() -> str | None:
    try:
        return metadata.version("homr")
    except metadata.PackageNotFoundError:
        return None


def _supports(flag: str) -> bool:
    """설치된 homr 가 이 옵션을 아는지 (버전마다 옵션이 다르다)."""
    try:
        out = subprocess.run([*HOMR_CMD, "--help"], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return False
    return flag in out


_EXTRA_ARGS: list[str] | None = None


def _homr_args() -> list[str]:
    global _EXTRA_ARGS
    if _EXTRA_ARGS is None:
        _EXTRA_ARGS = ["--write-staff-positions"]
        if _supports("--no-title"):
            _EXTRA_ARGS.append("--no-title")  # 제목 글자 인식은 필요 없고 시간만 든다
    return _EXTRA_ARGS


class WorkerError(RuntimeError):
    pass


class HomrWorker:
    """homr 를 켜 둔 작업자 (server/homr_worker.py). 한 번에 한 쪽씩, 문제가 생기면 다시 켠다."""

    MAX_JOBS = 30  # 이만큼 처리하면 새로 켠다 (메모리가 쌓이지 않게)

    def __init__(self, cmd: list[str]) -> None:
        self.cmd = cmd
        self.proc: subprocess.Popen | None = None
        self.lines: queue.Queue[str | None] = queue.Queue()
        self.jobs = 0
        self.lock = threading.Lock()

    def _start(self) -> None:
        self.close()
        log_dir = os.environ.get("READ_CLASSIC_LOG_DIR") or tempfile.gettempdir()
        log = open(Path(log_dir) / "homr-worker.log", "ab")  # noqa: SIM115 (작업자가 끝날 때까지 쓴다)
        env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
        self.proc = subprocess.Popen(
            self.cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, env=env, text=True, encoding="utf-8", bufsize=1
        )
        log.close()
        self.lines = queue.Queue()
        out = self.proc.stdout

        def pump() -> None:
            for line in out:  # type: ignore[union-attr]
                self.lines.put(line)
            self.lines.put(None)

        threading.Thread(target=pump, daemon=True).start()
        self._read(180)  # {"ready": true}
        self.jobs = 0

    def _read(self, timeout: float) -> dict:
        try:
            line = self.lines.get(timeout=timeout)
        except queue.Empty:
            self.close()
            raise subprocess.TimeoutExpired(self.cmd, timeout) from None
        if line is None:
            self.close()
            raise WorkerError("작업자가 멈췄습니다")
        try:
            return json.loads(line)
        except ValueError:
            self.close()
            raise WorkerError(f"작업자 응답을 읽지 못했습니다: {line[:200]}") from None

    def run(self, args: list[str], timeout: float) -> tuple[int, str]:
        with self.lock:
            if self.proc is None or self.proc.poll() is not None or self.jobs >= self.MAX_JOBS:
                self._start()
            assert self.proc and self.proc.stdin
            try:
                self.proc.stdin.write(json.dumps({"args": args}) + "\n")
                self.proc.stdin.flush()
            except OSError as e:
                self.close()
                raise WorkerError(f"작업자에게 보내지 못했습니다: {e}") from None
            reply = self._read(timeout)
            self.jobs += 1
            return int(reply.get("code", 1)), str(reply.get("log", ""))

    def close(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            try:
                self.proc.wait(5)
            except subprocess.TimeoutExpired:
                pass
        self.proc = None


WORKER: HomrWorker | None = None


def _worker() -> HomrWorker | None:
    global WORKER
    if WORKER is None and HOMR_WORKER_CMD:
        WORKER = HomrWorker(HOMR_WORKER_CMD)
    return WORKER


def _recognise(args: list[str], cwd: str) -> tuple[int, str, bool]:
    """homr 로 한 쪽 인식 → (종료 코드, 기록, 작업자로 했는지). 작업자가 잘못되면 쪽마다 새로 켜서 한다."""
    worker = _worker()
    if worker is not None:
        try:
            code, log = worker.run(args, OMR_TIMEOUT)
            return code, log, True
        except WorkerError as e:
            print(f"[omr] 작업자 문제, 따로 실행합니다: {e}", file=sys.stderr, flush=True)
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    proc = subprocess.run(
        [*HOMR_CMD, *args], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=OMR_TIMEOUT, env=env
    )
    return proc.returncode, (proc.stdout or b"").decode("utf-8", "replace"), False


def _read_staffs(path: Path) -> list[list[float]]:
    staffs: list[list[float]] = []
    if not path.exists():
        return staffs
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) != 5:
            continue
        try:
            _, cx, cy, w, h = (float(p) for p in parts)
        except ValueError:
            continue
        staffs.append([round(cx, 5), round(cy, 5), round(w, 5), round(h, 5)])
    return staffs


def failure_message(output: str) -> str:
    """homr 가 남긴 기록에서 사람이 알아들을 수 있는 이유를 고른다."""
    if "No staffs found" in output or "No noteheads found" in output:
        return "이 쪽에서 오선이나 음표를 찾지 못했어요. (표지·해설 쪽이거나, 사진이 흐리거나 기울었을 수 있어요)"
    if "MemoryError" in output or "bad allocation" in output or "Failed to allocate" in output:
        return "컴퓨터 메모리가 모자라 이 쪽을 인식하지 못했어요. 다른 프로그램을 닫고 다시 해 보세요."
    if "Failed to read" in output:
        return "이 쪽 그림 파일을 열지 못했어요."
    lines = [ln.strip() for ln in output.strip().splitlines() if ln.strip()]
    last = lines[-1] if lines else ""
    return "악보 인식 프로그램에 문제가 생겼어요." + (f" ({last[:200]})" if last else "")


DESKTOP = os.environ.get("READ_CLASSIC_DESKTOP") == "1"  # 노트북용 앱으로 실행 중인지


LAST_TAB_PING = 0.0  # 앱 화면(브라우저 탭)이 마지막으로 연결을 확인한 때 (업데이트 뒤 탭을 새로 열지 정할 때 쓴다)
_active = 0  # 지금 인식 중인 쪽 수


@app.get("/api/health")
async def health(tab: int = 0) -> dict:
    global LAST_TAB_PING
    if tab:
        LAST_TAB_PING = time.monotonic()
    return {
        "ok": True,
        "engine": "homr",
        "version": _engine_version(),
        "desktop": DESKTOP,
        "app": app_version(),
        "pid": os.getpid(),
    }


def _local_desktop_only(request: Request) -> None:
    """노트북용 앱에서, 이 컴퓨터 안에서 온 요청만 받는다."""
    if not DESKTOP or (request.client and request.client.host not in ("127.0.0.1", "::1", "localhost")):
        raise HTTPException(404, "Not Found")


@app.post("/api/shutdown")
async def shutdown(request: Request) -> dict:
    """노트북용 앱의 "앱 끄기" 버튼."""
    _local_desktop_only(request)
    threading.Timer(0.5, lambda: os._exit(0)).start()
    return {"ok": True}


@app.get("/api/update")
async def update_status(request: Request, force: int = 0) -> dict:
    """새 판이 있는지 (인터넷이 없으면 offline)."""
    _local_desktop_only(request)
    await asyncio.to_thread(updater.check, bool(force))
    return updater.status()


@app.post("/api/update/install")
async def update_install(request: Request) -> dict:
    """새 판을 내려받아 설치한다. 설치가 시작되면 이 앱은 꺼지고, 끝나면 새 판이 다시 켜진다."""
    _local_desktop_only(request)
    if _active:
        raise HTTPException(409, "악보를 인식하는 중이에요. 끝난 뒤에 업데이트해 주세요.")
    try:
        return updater.start(lambda: os._exit(0))
    except RuntimeError as e:
        raise HTTPException(400, str(e)) from None


@app.post("/api/omr")
async def omr(image: UploadFile) -> JSONResponse:
    """악보 한 쪽 이미지 → MusicXML (음표마다 imgpos 주석 포함)."""
    suffix = IMAGE_TYPES.get((image.content_type or "").split(";")[0].strip().lower())
    if suffix is None:
        raise HTTPException(415, "JPEG, PNG, WebP 이미지만 받을 수 있습니다. PDF 는 앱에서 쪽별 이미지로 바꿔 보냅니다.")
    data = await image.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, f"이미지가 너무 큽니다 (최대 {MAX_UPLOAD // (1024 * 1024)}MB).")
    if not data:
        raise HTTPException(400, "빈 파일입니다.")

    with tempfile.TemporaryDirectory(prefix="omr-") as tmp:
        src = Path(tmp) / f"page{suffix}"
        src.write_bytes(data)
        started = time.monotonic()
        global _active
        async with _slots:
            _active += 1
            # 일반 스레드에서 실행: 운영체제/이벤트 루프 종류와 상관없이 동작 (Windows 포함)
            try:
                code, text, by_worker = await asyncio.to_thread(_recognise, [*_homr_args(), str(src)], tmp)
            except subprocess.TimeoutExpired:
                raise HTTPException(504, "악보 인식 시간이 너무 오래 걸려 중단했습니다.") from None
            finally:
                _active -= 1
        result = src.with_suffix(".musicxml")
        if code != 0 or not result.exists():
            # 원인을 찾을 수 있게 전체 기록을 남긴다 (노트북 앱은 기록 파일로 간다)
            print(f"[omr] 인식 실패 (종료 코드 {code})\n{text}", file=sys.stderr, flush=True)
            raise HTTPException(422, failure_message(text))
        xml = result.read_text(encoding="utf-8")
        staffs = _read_staffs(src.with_suffix(".txt"))
    return JSONResponse(
        {
            "musicxml": xml,
            "staffs": staffs,
            "engine": "homr",
            "version": _engine_version(),
            "seconds": round(time.monotonic() - started, 1),
            "worker": by_worker,
        }
    )


if STATIC_DIR.is_dir():
    # 같은 주소에서 웹 앱도 함께 제공 (http://localhost:8000)
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="web")
