"""
Read Classic 악보 인식 서버.

사진·스캔한 악보 한 쪽(이미지)을 받아 homr 로 MusicXML 을 만들어 돌려준다.
함께 돌려주는 위치 정보로 앱이 원본 악보 위에 지금 연주 위치를 표시한다.
  - staffs: 줄(시스템)마다 보표 상자 [중심x, 중심y, 너비, 높이] (이미지 크기에 대한 비율)
  - 새 homr 는 음표마다 `<!-- imgpos: x, y -->` 주석도 남긴다 (있으면 앱이 더 정확히 표시)

환경 변수
  HOMR_CMD         homr 실행 명령 (기본: "homr")
  OMR_TIMEOUT      한 쪽 인식 제한 시간(초, 기본 600)
  OMR_CONCURRENCY  동시에 인식할 쪽 수 (기본 1; CPU 를 많이 쓴다)
  MAX_UPLOAD_MB    업로드 최대 크기 (기본 25)
  ALLOWED_ORIGINS  다른 주소(예: GitHub Pages)의 앱에서 부를 때 허용할 origin, 쉼표로 구분 (기본 "*")
  STATIC_DIR       함께 서비스할 웹 앱 폴더 (기본: 저장소의 dist/)
"""

from __future__ import annotations

import asyncio
import os
import shlex
import subprocess
import tempfile
import threading
import time
from importlib import metadata
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

HOMR_CMD = shlex.split(os.environ.get("HOMR_CMD", "homr"))
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


DESKTOP = os.environ.get("READ_CLASSIC_DESKTOP") == "1"  # 노트북용 앱으로 실행 중인지


@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "engine": "homr", "version": _engine_version(), "desktop": DESKTOP}


@app.post("/api/shutdown")
async def shutdown(request: Request) -> dict:
    """노트북용 앱의 "앱 끄기" 버튼. 이 컴퓨터 안에서 온 요청만 받는다."""
    if not DESKTOP or (request.client and request.client.host not in ("127.0.0.1", "::1", "localhost")):
        raise HTTPException(404, "Not Found")
    threading.Timer(0.5, lambda: os._exit(0)).start()
    return {"ok": True}


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
        async with _slots:
            # 일반 스레드에서 실행: 운영체제/이벤트 루프 종류와 상관없이 동작 (Windows 포함)
            env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
            try:
                proc = await asyncio.to_thread(
                    subprocess.run,
                    [*HOMR_CMD, *_homr_args(), str(src)],
                    cwd=tmp,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    timeout=OMR_TIMEOUT,
                    env=env,
                )
            except subprocess.TimeoutExpired:
                raise HTTPException(504, "악보 인식 시간이 너무 오래 걸려 중단했습니다.") from None
        out = proc.stdout
        result = src.with_suffix(".musicxml")
        if proc.returncode != 0 or not result.exists():
            tail = (out or b"").decode("utf-8", "replace").strip().splitlines()[-5:]
            raise HTTPException(422, "악보를 인식하지 못했습니다. " + " / ".join(tail))
        xml = result.read_text(encoding="utf-8")
        staffs = _read_staffs(src.with_suffix(".txt"))
    return JSONResponse(
        {
            "musicxml": xml,
            "staffs": staffs,
            "engine": "homr",
            "version": _engine_version(),
            "seconds": round(time.monotonic() - started, 1),
        }
    )


if STATIC_DIR.is_dir():
    # 같은 주소에서 웹 앱도 함께 제공 (http://localhost:8000)
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="web")
