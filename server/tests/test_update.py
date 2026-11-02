"""업데이트 확인·내려받기 시험 (실제 설치는 CI 의 desktop/update_test.py 가 노트북 앱으로 시험한다)."""
import http.server
import json
import threading
from functools import partial
from pathlib import Path

import pytest

from server import update


@pytest.fixture()
def release(tmp_path, monkeypatch):
    """가짜 릴리스 서버: latest.json 과 설치 파일 (2MB)."""
    (tmp_path / "setup.bin").write_bytes(b"x" * (2 * 1024 * 1024))
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *args) -> None:  # type: ignore[no-untyped-def]
            pass

    handler = partial(Quiet, directory=str(tmp_path))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"

    def publish(build: int, file: str = "setup.bin") -> None:
        url = f"{base}/{file}"
        (tmp_path / "latest.json").write_text(
            json.dumps({"build": build, "version": f"1.0.{build}", "tag": f"laptop-{build}", "files": {"windows": url, "mac": url, "linux": url}}),
            encoding="utf-8",
        )

    monkeypatch.setenv("READ_CLASSIC_UPDATE_URL", f"{base}/latest.json")
    monkeypatch.setenv("READ_CLASSIC_BUILD", "7")
    monkeypatch.setenv("READ_CLASSIC_VERSION", "1.0.7")
    yield publish, base, tmp_path
    srv.shutdown()


def test_newer_build_is_offered(release):
    publish, _, _ = release
    publish(9)
    u = update.Updater()
    u.check()
    st = u.status()
    assert st["available"] is True
    assert st["current"] == {"build": 7, "version": "1.0.7"}
    assert st["latest"]["version"] == "1.0.9"


def test_same_or_older_build_is_not_offered(release):
    publish, _, _ = release
    publish(7)
    u = update.Updater()
    u.check()
    assert u.status()["available"] is False


def test_self_built_app_never_updates(release, monkeypatch):
    publish, _, _ = release
    publish(9)
    monkeypatch.setenv("READ_CLASSIC_BUILD", "0")
    u = update.Updater()
    u.check()
    assert u.status()["available"] is False


def test_offline_is_quiet(monkeypatch):
    monkeypatch.setenv("READ_CLASSIC_UPDATE_URL", "http://127.0.0.1:9/latest.json")
    u = update.Updater()
    u.check()
    st = u.status()
    assert st["available"] is False and st["offline"] is True


def test_downloads_only_from_the_release_location(release, monkeypatch):
    _, base, _ = release
    assert update._allowed(f"{base}/setup.bin")
    assert not update._allowed("https://example.com/setup.exe")
    monkeypatch.delenv("READ_CLASSIC_UPDATE_URL")
    assert update._allowed("https://github.com/saltsongsun/read_classic/releases/download/laptop-9/ReadClassic-Windows-Setup.exe")
    assert not update._allowed("https://github.com/someone/else/releases/download/x/setup.exe")


def test_download_reports_progress_and_checks_size(release, tmp_path):
    _, base, _ = release
    u = update.Updater()
    target = tmp_path / "got.bin"
    u._download(f"{base}/setup.bin", target)
    assert target.stat().st_size == 2 * 1024 * 1024
    assert u.progress > 0.9


def test_refuses_a_tiny_file(release, tmp_path):
    _, base, root = release
    (root / "tiny.bin").write_bytes(b"not an installer")
    with pytest.raises(IOError):
        update.Updater()._download(f"{base}/tiny.bin", tmp_path / "t.bin")
