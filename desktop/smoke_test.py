"""
만든 노트북용 묶음이 실제로 동작하는지 확인한다.

  python desktop/smoke_test.py [실행 파일 경로]

- 묶음을 실행해서 웹 앱이 열리는지
- 예제 사진(tests/omr/ode-to-joy-photo.jpg)을 인식해서 음표·줄 위치가 나오는지
- 프록시를 막아 인터넷이 없는 상태에서도 되는지 (인식 중 무언가를 내려받으려 하면 실패한다)
"""

from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = 47911


def default_exe() -> Path:
    name = "read-classic.exe" if platform.system() == "Windows" else "read-classic"
    return ROOT / "desktop" / "build" / "dist" / "ReadClassic" / name


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


def main() -> None:
    exe = Path(sys.argv[1]) if len(sys.argv) > 1 else default_exe()
    env = dict(os.environ)
    # 인터넷 차단 흉내: 모든 외부 연결이 죽은 프록시로 가게 한다
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"):
        env[k] = "http://127.0.0.1:9"
    env["NO_PROXY"] = env["no_proxy"] = "127.0.0.1,localhost"
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
        print("OK: 노트북용 묶음이 인터넷 없이 동작합니다")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()
