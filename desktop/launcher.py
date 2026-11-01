"""
Read Classic 노트북용 실행 프로그램.

더블클릭하면 이 컴퓨터 안에서 악보 인식 서버와 웹 앱을 띄우고 브라우저를 연다.
설치가 끝난 뒤에는 인터넷이 없어도 사진·PDF 악보 인식부터 연주 따라가기까지 모두 된다.

  read-classic            서버 실행 + 브라우저 열기
  read-classic --homr …   (내부용) 악보 인식 엔진 homr 를 실행한다. 서버가 쪽마다 이 모드로 자신을 부른다.
  read-classic --no-browser --port N   (시험용)
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

DEFAULT_PORT = 47800  # 고정 포트: 브라우저에 저장된 악보는 주소(포트)별로 따로 저장되기 때문
FROZEN = getattr(sys, "frozen", False)


def resource_dir() -> Path:
    """묶음 파일 안의 자료 폴더 (개발 중에는 저장소 루트)."""
    if FROZEN:
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def run_homr(args: list[str]) -> None:
    sys.argv = ["homr", *args]
    from homr.main import main

    main()


def is_read_classic(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as r:
            return b'"engine"' in r.read()
    except Exception:
        return False


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def wait_and_open(url: str, port: int, open_browser: bool) -> None:
    for _ in range(240):
        if is_read_classic(port):
            print(f"\n  준비됐어요 → {url}\n  (이 창을 닫으면 Read Classic 이 꺼집니다)\n", flush=True)
            if open_browser:
                webbrowser.open(url)
            return
        time.sleep(0.25)
    print("  서버가 시작되지 않았어요. 이 창의 메시지를 확인해 주세요.", flush=True)


def use_utf8_output() -> None:
    """Windows 에서 출력이 파일·파이프로 갈 때 한글 때문에 멈추지 않게."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:
            pass


def main() -> None:
    use_utf8_output()
    args = sys.argv[1:]
    if args and args[0] == "--homr":
        run_homr(args[1:])
        return

    open_browser = "--no-browser" not in args
    port = DEFAULT_PORT
    if "--port" in args:
        port = int(args[args.index("--port") + 1])

    print("Read Classic · 악보 따라가기", flush=True)
    if is_read_classic(port):
        # 이미 켜져 있으면 브라우저만 다시 연다
        print(f"  이미 실행 중이에요 → http://localhost:{port}", flush=True)
        if open_browser:
            webbrowser.open(f"http://localhost:{port}")
        return
    if not port_free(port):
        for p in range(port + 1, port + 20):
            if port_free(p):
                print(f"  {port}번 포트를 다른 프로그램이 쓰고 있어 {p}번으로 엽니다.")
                print("  (포트가 바뀌면 전에 저장한 악보가 목록에 안 보일 수 있어요. 그 프로그램을 끄고 다시 실행해 주세요.)")
                port = p
                break

    os.environ.setdefault("STATIC_DIR", str(resource_dir() / "web"))
    from server import app as server_app

    # 악보 한 쪽마다 이 프로그램을 "--homr" 모드로 따로 실행 (끝나면 메모리를 돌려준다)
    if FROZEN:
        server_app.HOMR_CMD = [sys.executable, "--homr"]
    else:
        server_app.HOMR_CMD = [sys.executable, str(Path(__file__).resolve()), "--homr"]

    url = f"http://localhost:{port}"
    print(f"  시작하는 중… 잠시 후 브라우저가 열려요 ({url})", flush=True)
    threading.Thread(target=wait_and_open, args=(url, port, open_browser), daemon=True).start()

    import uvicorn

    uvicorn.run(server_app.app, host="127.0.0.1", port=port, log_level="warning", loop="asyncio", http="h11", ws="none")


if __name__ == "__main__":
    main()
