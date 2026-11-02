"""
Read Classic 노트북용 실행 프로그램.

아이콘을 누르면 이 컴퓨터 안에서 악보 인식 서버와 웹 앱을 띄우고 브라우저를 연다.
검은 창 없이 뒤에서 돌고, 끌 때는 앱의 설정 → "앱 끄기" 를 누른다 (컴퓨터를 끄면 같이 꺼진다).
설치가 끝난 뒤에는 인터넷이 없어도 사진·PDF 악보 인식부터 연주 따라가기까지 모두 된다.

  read-classic            서버 실행 + 브라우저 열기 (이미 켜져 있으면 브라우저만 연다)
  read-classic --homr …   (내부용) 악보 인식 엔진 homr 를 실행한다. 서버가 쪽마다 이 모드로 자신을 부른다.
  read-classic --no-browser --port N   (시험용)
"""

from __future__ import annotations

import os
import platform
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from pathlib import Path

DEFAULT_PORT = 47800  # 고정 포트: 브라우저에 저장된 악보는 주소(포트)별로 따로 저장되기 때문
FROZEN = getattr(sys, "frozen", False)
SYSTEM = platform.system()
if not FROZEN:
    # 개발 중 실행 (python desktop/launcher.py): 저장소 루트의 server/ 를 찾을 수 있게
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def resource_dir() -> Path:
    """묶음 파일 안의 자료 폴더 (개발 중에는 저장소 루트)."""
    if FROZEN:
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    return Path(__file__).resolve().parent.parent


def log_dir() -> Path:
    if SYSTEM == "Windows":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "ReadClassic"
    elif SYSTEM == "Darwin":
        base = Path.home() / "Library" / "Logs" / "ReadClassic"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "read-classic"
    base.mkdir(parents=True, exist_ok=True)
    return base


def setup_output(log_name: str) -> None:
    """창 없이 실행되면 출력할 곳이 없으므로 기록 파일로 보낸다. 한글 때문에 멈추지 않게 UTF-8 로."""
    if sys.stdout is None or sys.stderr is None:
        try:
            # 부모(서버)가 파이프를 연결해 줬으면 그쪽으로
            os.fstat(1)
            stream = open(1, "w", encoding="utf-8", errors="replace", closefd=False, buffering=1)
        except Exception:
            stream = open(log_dir() / log_name, "a", encoding="utf-8", errors="replace", buffering=1)
        sys.stdout = sys.stdout or stream
        sys.stderr = sys.stderr or stream
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:
            pass


def show_error(message: str) -> None:
    """창 없는 앱이라 문제가 생기면 대화상자로 알려 준다."""
    print(message, flush=True)
    if os.environ.get("READ_CLASSIC_NO_DIALOG"):  # 자동 시험 중에는 대화상자를 띄우지 않는다
        return
    try:
        if SYSTEM == "Windows":
            import ctypes

            ctypes.windll.user32.MessageBoxW(0, message, "Read Classic", 0x10)
        elif SYSTEM == "Darwin":
            text = message.replace('"', "'")
            subprocess.run(["osascript", "-e", f'display alert "Read Classic" message "{text}" as critical'], timeout=120)
    except Exception:
        pass


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
    for _ in range(480):
        if is_read_classic(port):
            print(f"준비됐어요 → {url}", flush=True)
            if open_browser:
                webbrowser.open(url)
            return
        time.sleep(0.25)
    show_error(f"Read Classic 을 시작하지 못했어요.\n기록 파일: {log_dir() / 'read-classic.log'}")
    os._exit(1)


def serve(args: list[str]) -> None:
    open_browser = "--no-browser" not in args
    port = DEFAULT_PORT
    if "--port" in args:
        port = int(args[args.index("--port") + 1])

    print(f"Read Classic 시작 ({time.strftime('%Y-%m-%d %H:%M:%S')})", flush=True)
    if is_read_classic(port):
        # 이미 켜져 있으면 브라우저만 다시 연다
        print(f"이미 실행 중이에요 → http://localhost:{port}", flush=True)
        if open_browser:
            webbrowser.open(f"http://localhost:{port}")
        return
    if not port_free(port):
        for p in range(port + 1, port + 20):
            if port_free(p):
                print(f"{port}번 포트를 다른 프로그램이 쓰고 있어 {p}번으로 엽니다.", flush=True)
                port = p
                break

    os.environ.setdefault("STATIC_DIR", str(resource_dir() / "web"))
    os.environ["READ_CLASSIC_DESKTOP"] = "1"  # 앱 안의 "앱 끄기" 버튼을 켠다
    from server import app as server_app

    # 악보 한 쪽마다 이 프로그램을 "--homr" 모드로 따로 실행 (끝나면 메모리를 돌려준다)
    if FROZEN:
        server_app.HOMR_CMD = [sys.executable, "--homr"]
    else:
        server_app.HOMR_CMD = [sys.executable, str(Path(__file__).resolve()), "--homr"]

    url = f"http://localhost:{port}"
    threading.Thread(target=wait_and_open, args=(url, port, open_browser), daemon=True).start()

    import uvicorn

    uvicorn.run(server_app.app, host="127.0.0.1", port=port, log_level="warning", loop="asyncio", http="h11", ws="none")


def main() -> None:
    args = sys.argv[1:]
    if args and args[0] == "--homr":
        setup_output("homr.log")
        run_homr(args[1:])
        return
    setup_output("read-classic.log")
    try:
        serve(args)
    except SystemExit:
        raise
    except BaseException:
        traceback.print_exc()
        show_error(f"Read Classic 에 문제가 생겼어요.\n기록 파일: {log_dir() / 'read-classic.log'}")
        sys.exit(1)


if __name__ == "__main__":
    main()
