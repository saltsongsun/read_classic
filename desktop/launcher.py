"""
Read Classic 노트북용 실행 프로그램.

아이콘을 누르면 이 컴퓨터 안에서 악보 인식 서버와 웹 앱을 띄우고 브라우저를 연다.
검은 창 없이 뒤에서 돌고, 끌 때는 앱의 설정 → "앱 끄기" 를 누른다 (컴퓨터를 끄면 같이 꺼진다).
설치가 끝난 뒤에는 인터넷이 없어도 사진·PDF 악보 인식부터 연주 따라가기까지 모두 된다.

  read-classic            서버 실행 + 브라우저 열기 (이미 켜져 있으면 브라우저만 연다)
  read-classic --homr …   (내부용) 악보 인식 엔진 homr 를 실행한다. 서버가 쪽마다 이 모드로 자신을 부른다.
  read-classic --diag     (시험용) 글자 인코딩 설정 등을 JSON 으로 보여 준다.
  read-classic --after-update   업데이트 설치가 끝난 뒤 설치 프로그램이 부른다.
                          열려 있던 앱 화면이 다시 연결되면 브라우저 탭을 새로 열지 않는다.
  환경 변수 READ_CLASSIC_NO_BROWSER=1 이면 브라우저를 열지 않는다 (시험용).
  read-classic --no-browser --port N   (시험용)
"""

from __future__ import annotations

import json
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


def force_utf8_text_files() -> None:
    """글자 파일을 UTF-8 로 읽고 쓰게 한다.

    한국어 Windows 는 기본 글자 인코딩이 cp949 라서, 인코딩을 따로 적지 않고 파일을 여는
    라이브러리(musicxml 이 악보 규격 파일을 읽을 때 등)가 UTF-8 파일을 못 읽고 멈춘다.
    묶음 프로그램은 처음부터 UTF-8 모드로 돌게 해 두었고(read_classic.spec), 이건 혹시 그게
    꺼져 있을 때를 위한 안전장치다.
    """
    if sys.flags.utf8_mode:
        return
    import builtins
    import io

    real_open = io.open

    def open_utf8(file, mode="r", buffering=-1, encoding=None, *args, **kwargs):  # type: ignore[no-untyped-def]
        if "b" not in mode and encoding in (None, "locale"):
            encoding = "utf-8"
        return real_open(file, mode, buffering, encoding, *args, **kwargs)

    builtins.open = open_utf8
    io.open = open_utf8  # pathlib 의 Path.open / read_text 도 이걸 쓴다


def allow_unicode_image_paths() -> None:
    """Windows 의 OpenCV 는 한글 등이 들어간 경로(예: 사용자 이름이 한글)의 그림을 읽고 쓰지 못한다.
    그런 경로는 파일을 바이트로 읽어 메모리에서 풀고, 쓸 때도 메모리에서 만든 뒤 저장한다."""
    if SYSTEM != "Windows":
        return
    import cv2
    import numpy as np

    real_imread, real_imwrite = cv2.imread, cv2.imwrite

    def imread(filename, flags=cv2.IMREAD_COLOR):  # type: ignore[no-untyped-def]
        name = os.fspath(filename)
        if name.isascii():
            return real_imread(name, flags)
        try:
            data = np.fromfile(name, dtype=np.uint8)
        except OSError:
            return None
        return cv2.imdecode(data, flags) if data.size else None

    def imwrite(filename, img, params=None):  # type: ignore[no-untyped-def]
        name = os.fspath(filename)
        if name.isascii():
            return real_imwrite(name, img, params) if params is not None else real_imwrite(name, img)
        ok, buf = cv2.imencode(os.path.splitext(name)[1] or ".png", img, params if params is not None else [])
        if ok:
            buf.tofile(name)
        return ok

    cv2.imread = imread
    cv2.imwrite = imwrite


def run_homr(args: list[str]) -> None:
    force_utf8_text_files()
    allow_unicode_image_paths()
    sys.argv = ["homr", *args]
    from homr.main import main

    main()


def diag() -> None:
    import json
    import locale

    with open(os.devnull) as f:
        open_encoding = f.encoding
    print(
        json.dumps(
            {
                "utf8_mode": sys.flags.utf8_mode,
                "open_encoding": open_encoding,
                "preferred_encoding": locale.getpreferredencoding(False),
                "frozen": FROZEN,
                "executable": sys.executable,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def is_read_classic(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as r:
            return b'"engine"' in r.read()
    except Exception:
        return False


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        if SYSTEM != "Windows":
            # 방금 끈 앱의 포트(TIME_WAIT)도 다시 쓸 수 있게 (서버 uvicorn 도 이렇게 연다)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def load_version() -> None:
    """묶을 때 넣어 둔 판 정보 (version.json) → 서버가 업데이트를 확인할 때 쓴다."""
    try:
        info = json.loads((resource_dir() / "version.json").read_text(encoding="utf-8"))
        os.environ.setdefault("READ_CLASSIC_BUILD", str(int(info.get("build", 0))))
        os.environ.setdefault("READ_CLASSIC_VERSION", str(info.get("version", "dev")))
    except Exception:
        pass


def wait_and_open(url: str, port: int, open_browser: bool, after_update: bool = False) -> None:
    for _ in range(480):
        if is_read_classic(port):
            print(f"준비됐어요 → {url}", flush=True)
            if open_browser and after_update:
                # 업데이트 전부터 열려 있던 앱 화면이 다시 연결되면 새 탭을 열지 않는다
                from server import app as server_app

                ready = time.monotonic()
                while time.monotonic() - ready < 8:
                    if server_app.LAST_TAB_PING > ready - 1:
                        print("열려 있던 앱 화면이 다시 연결됐어요", flush=True)
                        return
                    time.sleep(0.25)
            if open_browser:
                webbrowser.open(url)
            return
        time.sleep(0.25)
    show_error(f"Read Classic 을 시작하지 못했어요.\n기록 파일: {log_dir() / 'read-classic.log'}")
    os._exit(1)


def serve(args: list[str]) -> None:
    open_browser = "--no-browser" not in args and not os.environ.get("READ_CLASSIC_NO_BROWSER")
    after_update = "--after-update" in args
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

    load_version()
    os.environ.setdefault("STATIC_DIR", str(resource_dir() / "web"))
    os.environ["READ_CLASSIC_DESKTOP"] = "1"  # 앱 안의 "앱 끄기" 버튼을 켠다
    from server import app as server_app

    # 악보 한 쪽마다 이 프로그램을 "--homr" 모드로 따로 실행 (끝나면 메모리를 돌려준다)
    if FROZEN:
        server_app.HOMR_CMD = [sys.executable, "--homr"]
    else:
        server_app.HOMR_CMD = [sys.executable, str(Path(__file__).resolve()), "--homr"]

    url = f"http://localhost:{port}"
    threading.Thread(target=wait_and_open, args=(url, port, open_browser, after_update), daemon=True).start()

    import uvicorn

    uvicorn.run(server_app.app, host="127.0.0.1", port=port, log_level="warning", loop="asyncio", http="h11", ws="none")


def main() -> None:
    args = sys.argv[1:]
    if args and args[0] == "--homr":
        setup_output("homr.log")
        try:
            run_homr(args[1:])
        except SystemExit:
            raise
        except BaseException:
            # 창으로 띄우지 않고 서버에 글로 알린다 (서버가 앱 화면에 한국어로 보여 준다)
            traceback.print_exc()
            sys.stdout.flush()
            sys.stderr.flush()
            sys.exit(1)
        return
    if args and args[0] == "--diag":
        setup_output("read-classic.log")
        diag()
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
