"""
만든 노트북용 묶음이 실제로 동작하는지 확인한다.

  python desktop/smoke_test.py [실행 파일 경로] [--unicode-paths]

- 묶음이 UTF-8 모드로 도는지 (한국어 Windows 의 cp949 기본 인코딩 때문에 인식이 멈추지 않게)
- 묶음을 실행해서 웹 앱이 열리는지
- 예제 사진(tests/omr/ode-to-joy-photo.jpg)을 인식해서 음표·줄 위치가 나오는지
- 프록시를 막아 인터넷이 없는 상태에서도 되는지 (인식 중 무언가를 내려받으려 하면 실패한다)
- --unicode-paths: 프로그램과 임시 폴더를 한글 이름 폴더에 두고도 되는지
  (Windows 사용자 이름이 한글이면 설치 폴더·임시 폴더 경로에 한글이 들어간다)
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 47911
CLEANUP: list[Path] = []  # 시험이 끝나면 지울 복사본


def default_exe() -> Path:
    dist = ROOT / "desktop" / "build" / "dist"
    system = platform.system()
    if system == "Windows":
        return dist / "ReadClassic" / "read-classic.exe"
    if system == "Darwin":
        return dist / "Read Classic.app" / "Contents" / "MacOS" / "read-classic"
    return dist / "ReadClassic" / "read-classic"


def get(path: str) -> bytes:
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=10) as r:
        return r.read()


def post_image(path: Path) -> dict:
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"page.jpg\"\r\n"
        "Content-Type: image/jpeg\r\n\r\n"
    ).encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}/api/omr",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=900) as r:
        return json.loads(r.read())


def clean_env() -> dict[str, str]:
    """실제 사용자 컴퓨터처럼: 시험 환경에서 켜 둔 파이썬 UTF-8 설정은 빼고 실행한다."""
    env = dict(os.environ)
    for k in ("PYTHONUTF8", "PYTHONIOENCODING", "PYTHONLEGACYWINDOWSSTDIO"):
        env.pop(k, None)
    return env


def check_utf8_mode(exe: Path, env: dict[str, str]) -> None:
    out = subprocess.run([str(exe), "--diag"], env=env, capture_output=True, timeout=120)
    text = out.stdout.decode("utf-8", "replace").strip()
    print("diag:", text or out.stderr.decode("utf-8", "replace"))
    info = json.loads(text.splitlines()[-1])
    assert info["utf8_mode"] == 1, "묶음 프로그램이 UTF-8 모드로 돌지 않습니다 (한국어 Windows 에서 인식이 멈춥니다)"
    assert info["open_encoding"].lower().replace("-", "") == "utf8", f"파일 기본 인코딩이 {info['open_encoding']} 입니다"


def move_to_unicode_dir(exe: Path, env: dict[str, str]) -> Path:
    """실행 폴더를 통째로 한글 이름 폴더로 복사하고, 임시 폴더도 한글 이름으로 바꾼다."""
    root = Path(tempfile.mkdtemp(prefix="rc-"))
    CLEANUP.append(root)
    base = root / "악보 시험 ü"
    app_dir = exe.parent
    shutil.copytree(app_dir, base / app_dir.name, symlinks=True)
    tmp = base / "임시 폴더"
    tmp.mkdir(parents=True)
    for k in ("TEMP", "TMP", "TMPDIR"):
        env[k] = str(tmp)
    moved = base / app_dir.name / exe.name
    print("한글 경로에서 실행:", moved)
    return moved


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    exe = Path(args[0]) if args else default_exe()
    env = clean_env()
    if "--unicode-paths" in sys.argv:
        global PORT
        PORT += 10  # 바로 앞 시험이 쓴 포트와 겹치지 않게
        exe = move_to_unicode_dir(exe, env)
    check_utf8_mode(exe, env)
    # 인터넷 차단 흉내: 모든 외부 연결이 죽은 프록시로 가게 한다
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
        env[k] = "http://127.0.0.1:9"
    env["NO_PROXY"] = env["no_proxy"] = "127.0.0.1,localhost"
    env["READ_CLASSIC_NO_DIALOG"] = "1"
    proc = subprocess.Popen([str(exe), "--no-browser", "--port", str(PORT)], env=env)
    try:
        for _ in range(240):
            try:
                health = json.loads(get("/api/health"))
                break
            except Exception:
                if proc.poll() is not None:
                    sys.exit(f"실행 파일이 바로 끝났습니다 (코드 {proc.returncode})")
                time.sleep(0.5)
        else:
            sys.exit("서버가 120초 안에 시작되지 않았습니다")
        print("health:", health)
        html = get("/").decode("utf-8")
        assert "Read Classic" in html, "웹 앱 첫 화면이 아닙니다"
        assert b"ode-to-joy" in get("/samples/index.json"), "예제 악보 목록이 없습니다"
        t0 = time.time()
        result = post_image(ROOT / "tests" / "omr" / "ode-to-joy-photo.jpg")
        notes = result["musicxml"].count("<pitch>")
        print(f"인식: {time.time() - t0:.1f}초, 음표 {notes}개, 줄 {len(result['staffs'])}개")
        assert notes >= 55, "음표를 충분히 인식하지 못했습니다"
        assert len(result["staffs"]) == 3, "줄 위치가 3개가 아닙니다"
        assert health.get("desktop") is True, "노트북 앱 표시(desktop)가 꺼져 있습니다"
        print("OK: 노트북용 묶음이 인터넷 없이 동작합니다")
        # "앱 끄기" 로 정말 꺼지는지
        req = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/shutdown", data=b"", method="POST")
        urllib.request.urlopen(req, timeout=10).read()
        proc.wait(timeout=20)
        print("OK: 앱 끄기로 종료됨")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        for path in CLEANUP:
            shutil.rmtree(path, ignore_errors=True)


if __name__ == "__main__":
    main()
