"""
노트북용 앱 업데이트.

GitHub 릴리스에 함께 올리는 latest.json 을 읽어 새 판이 있는지 보고, 사용자가 누르면 내려받아 설치한다.

  latest.json = {"build": 7, "version": "1.0.7", "tag": "laptop-7",
                 "files": {"windows": "https://…/ReadClassic-Windows-Setup.exe", "mac": "…dmg", "linux": "…zip"},
                 "page": "https://github.com/…/releases/tag/laptop-7"}

- Windows: 설치 파일을 받아 조용히(진행 창만 보이게) 실행하고 이 앱은 꺼진다. 설치가 끝나면 새 판이 다시 켜진다.
- Mac: dmg 를 받아 지금 앱 묶음(Read Classic.app)을 새 것으로 바꾸고 다시 연다.
  앱을 바꿀 수 없는 곳에서 돌고 있으면(예: dmg 안에서 바로 실행) dmg 를 열어 주고 끌어다 놓게 한다.
- Linux: 내려받을 쪽 페이지를 열어 준다.

설치는 사용자가 누를 때만 한다 (연주를 듣는 중에 저절로 꺼지면 안 되므로).
"""

from __future__ import annotations

import json
import os
import platform
import shlex
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

REPO = "saltsongsun/read_classic"
DEFAULT_URL = f"https://github.com/{REPO}/releases/latest/download/latest.json"
CHECK_EVERY_SEC = 30 * 60
SYSTEM = platform.system()
PLATFORM = {"Windows": "windows", "Darwin": "mac"}.get(SYSTEM, "linux")


def current() -> dict:
    """이 앱의 판. 개발 중 실행이면 build 0 (업데이트하지 않음)."""
    try:
        build = int(os.environ.get("READ_CLASSIC_BUILD", "0") or 0)
    except ValueError:
        build = 0
    return {"build": build, "version": os.environ.get("READ_CLASSIC_VERSION", "dev")}


def update_url() -> str:
    return os.environ.get("READ_CLASSIC_UPDATE_URL") or DEFAULT_URL


def _allowed(url: str) -> bool:
    """정해 둔 곳(GitHub 릴리스)에서만 받는다. 시험용으로 주소를 바꿨으면 그 주소의 서버만."""
    custom = os.environ.get("READ_CLASSIC_UPDATE_URL")
    if custom:
        base = custom.rsplit("/", 1)[0]
        return url.startswith(base + "/")
    return url.startswith(f"https://github.com/{REPO}/releases/download/")


class Updater:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.latest: dict | None = None
        self.checked_at = 0.0
        self.error: str | None = None
        self.state = "idle"  # idle | downloading | installing | manual | error
        self.progress = 0.0
        self.message = ""

    # ---- 확인 ----
    def check(self, force: bool = False) -> None:
        if not force and time.monotonic() - self.checked_at < CHECK_EVERY_SEC and (self.latest or self.error):
            return
        self.checked_at = time.monotonic()
        try:
            req = urllib.request.Request(update_url(), headers={"User-Agent": "ReadClassic", "Cache-Control": "no-cache"})
            with urllib.request.urlopen(req, timeout=8) as r:
                data = json.loads(r.read(200_000).decode("utf-8"))
            if not isinstance(data.get("build"), int):
                raise ValueError("판 정보가 없습니다")
            self.latest = data
            self.error = None
        except Exception as e:  # 인터넷이 없으면 조용히 넘어간다
            self.error = f"{type(e).__name__}: {e}"

    def status(self) -> dict:
        cur = current()
        latest = self.latest
        available = bool(latest and cur["build"] > 0 and latest["build"] > cur["build"] and latest.get("files", {}).get(PLATFORM))
        return {
            "current": cur,
            "latest": {k: latest.get(k) for k in ("build", "version", "tag", "page")} if latest else None,
            "available": available,
            "offline": latest is None and self.error is not None,
            "state": self.state,
            "progress": round(self.progress, 3),
            "message": self.message,
        }

    # ---- 설치 ----
    def start(self, on_exit) -> dict:  # type: ignore[no-untyped-def]
        with self.lock:
            st = self.status()
            if self.state in ("downloading", "installing"):
                return st
            if not st["available"]:
                raise RuntimeError("설치할 새 판이 없어요.")
            url = self.latest["files"][PLATFORM]  # type: ignore[index]
            if not _allowed(url):
                raise RuntimeError("업데이트 파일 주소가 올바르지 않아요.")
            if PLATFORM == "linux":
                webbrowser.open(self.latest.get("page") or url)  # type: ignore[union-attr]
                self.state = "manual"
                self.message = "내려받을 페이지를 열었어요. 새 판을 받아 풀어서 쓰세요."
                return self.status()
            self.state = "downloading"
            self.progress = 0.0
            self.message = "새 판을 내려받는 중"
        threading.Thread(target=self._run, args=(url, on_exit), daemon=True).start()
        return self.status()

    def _fail(self, message: str) -> None:
        self.state = "error"
        self.message = message
        print(f"[update] {message}", file=sys.stderr, flush=True)

    def _run(self, url: str, on_exit) -> None:  # type: ignore[no-untyped-def]
        try:
            folder = Path(tempfile.mkdtemp(prefix="read-classic-update-"))
            target = folder / url.rsplit("/", 1)[-1]
            self._download(url, target)
        except Exception as e:
            self._fail(f"내려받지 못했어요. 인터넷 연결을 확인하고 다시 해 보세요. ({type(e).__name__})")
            return
        try:
            self.state = "installing"
            self.progress = 1.0
            if PLATFORM == "windows":
                self._install_windows(target)
            else:
                if not self._install_mac(target):
                    return
        except Exception as e:
            self._fail(f"설치를 시작하지 못했어요. ({type(e).__name__}: {e})")
            return
        # 설치 프로그램이 파일을 바꿀 수 있게 이 앱은 끈다
        threading.Timer(1.5, on_exit).start()

    def _download(self, url: str, target: Path) -> None:
        req = urllib.request.Request(url, headers={"User-Agent": "ReadClassic"})
        with urllib.request.urlopen(req, timeout=60) as r, open(target, "wb") as f:
            total = int(r.headers.get("Content-Length") or 0)
            done = 0
            while True:
                chunk = r.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if total:
                    self.progress = min(0.99, done / total)
        if total and done != total:
            raise IOError("내려받은 파일 크기가 맞지 않습니다")
        if done < 1024 * 1024:
            raise IOError("내려받은 파일이 너무 작습니다")

    def _install_windows(self, setup: Path) -> None:
        # /SILENT: 진행 막대만 보이고 묻지 않는다. /RELAUNCH=1: 설치가 끝나면 새 판을 다시 켠다 (installer.iss)
        flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        subprocess.Popen(
            [str(setup), "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/RELAUNCH=1"],
            creationflags=flags,
            close_fds=True,
        )
        self.message = "설치하는 중이에요. 잠시 뒤 새 판이 저절로 열려요."

    def _install_mac(self, dmg: Path) -> bool:
        bundle = Path(sys.executable).resolve().parents[2]
        if bundle.suffix != ".app" or str(bundle).startswith("/Volumes/") or not os.access(bundle.parent, os.W_OK):
            # 바꿀 수 없는 곳에서 돌고 있다: dmg 를 열어 주고 끌어다 놓게 한다
            subprocess.run(["open", str(dmg)], check=False)
            self.state = "manual"
            self.message = "새 판 dmg 를 열었어요. Read Classic 을 응용 프로그램 폴더로 끌어다 놓아 바꿔 주세요."
            return False
        mount = Path(tempfile.mkdtemp(prefix="read-classic-dmg-"))
        subprocess.run(
            ["hdiutil", "attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", str(mount), str(dmg)],
            check=True,
            capture_output=True,
            timeout=120,
        )
        new_app = mount / "Read Classic.app"
        if not new_app.is_dir():
            subprocess.run(["hdiutil", "detach", str(mount), "-quiet"], check=False)
            raise RuntimeError("dmg 안에 앱이 없습니다")
        b = shlex.quote(str(bundle))
        script = f"""#!/bin/sh
# 이 앱이 꺼지길 기다렸다가 새 판으로 바꾸고 다시 연다 (실패하면 예전 판을 되돌린다)
while kill -0 {os.getpid()} 2>/dev/null; do sleep 0.3; done
rm -rf {b}.old
if mv {b} {b}.old && ditto {shlex.quote(str(new_app))} {b}; then
  rm -rf {b}.old
else
  rm -rf {b}; mv {b}.old {b}
fi
hdiutil detach {shlex.quote(str(mount))} -quiet
nohup {b}/Contents/MacOS/read-classic --after-update >/dev/null 2>&1 &
"""
        sh = mount.parent / f"read-classic-update-{os.getpid()}.sh"
        sh.write_text(script, encoding="utf-8")
        sh.chmod(0o755)
        subprocess.Popen(["/bin/sh", str(sh)], start_new_session=True, close_fds=True)
        self.message = "새 판으로 바꾸는 중이에요. 잠시 뒤 저절로 다시 열려요."
        return True


updater = Updater()
