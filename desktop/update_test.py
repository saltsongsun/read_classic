"""
노트북용 앱의 "업데이트" 를 처음부터 끝까지 시험한다 (CI 에서 실제 설치본으로).

  python desktop/update_test.py <실행 파일> <새 판 설치 파일(Windows .exe / Mac .dmg / Linux .zip)>

1. 이 컴퓨터에 가짜 릴리스 서버를 띄운다: latest.json(아주 큰 판 번호) + 설치 파일
2. 앱을 켜서 새 판이 있다고 나오는지 본다
3. "지금 업데이트" 와 같은 요청을 보낸다
4. Windows·Mac: 앱이 꺼졌다가 (설치 후) 새 프로세스로 다시 켜지는지 본다
   Linux: 내려받을 페이지를 열어 주는 방식인지 본다
"""

from __future__ import annotations

import functools
import http.server
import json
import os
import platform
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

PORT = 47800  # 업데이트 뒤 다시 켜지는 앱은 기본 포트로 뜬다
SYSTEM = platform.system()


def call(path: str, method: str = "GET", timeout: float = 10) -> dict:
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=b"" if method == "POST" else None, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def health() -> dict | None:
    try:
        return call("/api/health", timeout=2)
    except Exception:
        return None


def wait(cond, seconds: float, what: str):  # type: ignore[no-untyped-def]
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        v = cond()
        if v:
            return v
        time.sleep(0.5)
    sys.exit(f"시간 안에 {what} 않았습니다")


def main() -> None:
    exe, package = Path(sys.argv[1]), Path(sys.argv[2])
    # 1) 가짜 릴리스 서버
    root = package.parent
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args) -> None:  # type: ignore[no-untyped-def]
            pass

    handler = functools.partial(Quiet, directory=str(root))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    url = f"{base}/{package.name}"
    (root / "latest.json").write_text(
        json.dumps({"build": 99999, "version": "9.9.9", "tag": "test", "page": url, "files": {"windows": url, "mac": url, "linux": url}}),
        encoding="utf-8",
    )
    env = dict(os.environ)
    env.update(
        READ_CLASSIC_UPDATE_URL=f"{base}/latest.json",
        READ_CLASSIC_NO_BROWSER="1",
        READ_CLASSIC_NO_DIALOG="1",
        BROWSER="true" if SYSTEM == "Linux" else env.get("BROWSER", ""),  # Linux: 페이지 열기를 아무 일 없게
    )
    env.setdefault("READ_CLASSIC_BUILD", "1")
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
        env.pop(k, None)

    # 2) 앱 켜기
    if health():
        sys.exit(f"{PORT}번 포트에 이미 무언가 떠 있습니다")
    subprocess.Popen([str(exe), "--port", str(PORT)], env=env)
    first = wait(health, 120, "앱이 켜지지")
    print("켜짐:", first["app"], "pid", first["pid"])
    st = call("/api/update?force=1")
    print("업데이트 확인:", st)
    assert st["available"] is True, "새 판이 있다고 나오지 않습니다"
    assert st["latest"]["version"] == "9.9.9"

    # 3) 업데이트 시작
    started = call("/api/update/install", "POST")
    print("업데이트 시작:", started["state"], started["message"])
    if SYSTEM == "Linux":
        assert started["state"] == "manual", started
        call("/api/shutdown", "POST")
        print("OK: Linux 는 내려받을 페이지를 열어 줍니다")
        return

    # 4) 꺼졌다가 새 프로세스로 다시 켜지는지
    last: dict = {}

    def gone() -> bool:
        h = health()
        if h is None:
            return True
        try:
            s = call("/api/update", timeout=2)
            if s["state"] != last.get("state") or abs(s["progress"] - last.get("progress", -1)) > 0.2:
                print("  ", s["state"], s["progress"], s["message"])
                last.update(s)
            if s["state"] == "error":
                sys.exit(f"업데이트 실패: {s['message']}")
        except Exception:
            pass
        return False

    wait(gone, 300, "예전 판이 꺼지지")
    print("예전 판이 꺼짐 → 설치 중")
    second = wait(lambda: (h := health()) and h["pid"] != first["pid"] and h, 300, "새 판이 다시 켜지지")
    print("다시 켜짐:", second["app"], "pid", second["pid"])
    assert second["desktop"] is True
    if SYSTEM == "Windows":
        installed = Path(os.environ["LOCALAPPDATA"]) / "Programs" / "ReadClassic" / "read-classic.exe"
        assert installed.exists(), "설치된 실행 파일이 없습니다"
    else:
        assert exe.exists(), "앱 묶음이 바뀐 뒤 실행 파일이 없습니다"
    try:
        call("/api/shutdown", "POST")
    except Exception:
        pass
    wait(lambda: health() is None, 30, "새 판이 꺼지지")
    print("OK: 앱 안의 업데이트로 새 판을 설치하고 다시 켰습니다")


if __name__ == "__main__":
    main()
