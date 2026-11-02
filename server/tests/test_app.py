"""서버 배선 시험. 실제 인식은 fake_homr.py 가 대신한다 (인식 품질 시험이 아님)."""
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
os.environ["HOMR_CMD"] = f"{sys.executable} {HERE / 'fake_homr.py'}"
os.environ["STATIC_DIR"] = str(HERE / "no-static")

from fastapi.testclient import TestClient  # noqa: E402

from server.app import app  # noqa: E402

client = TestClient(app)
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["engine"] == "homr"
    assert r.json()["desktop"] is False


def test_shutdown_only_in_desktop_app():
    # 서버로 띄웠을 때는 끄기 요청을 받지 않는다
    assert client.post("/api/shutdown").status_code == 404


def test_recognises_a_page():
    r = client.post("/api/omr", files={"image": ("page.png", PNG, "image/png")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "<!-- imgpos: 120, 80 -->" in body["musicxml"]
    assert body["staffs"] == [[0.5, 0.2, 0.8, 0.1], [0.5, 0.5, 0.8, 0.1]]
    assert body["engine"] == "homr"


def test_rejects_pdf_and_empty():
    r = client.post("/api/omr", files={"image": ("a.pdf", b"%PDF-1.4", "application/pdf")})
    assert r.status_code == 415
    r = client.post("/api/omr", files={"image": ("a.png", b"", "image/png")})
    assert r.status_code == 400


def test_reports_recognition_failure():
    r = client.post("/api/omr", files={"image": ("bad.png", b"FAIL" + PNG, "image/png")})
    assert r.status_code == 422
    assert "오선이나 음표를 찾지 못했어요" in r.json()["detail"]


def test_reports_engine_crash_in_plain_words():
    r = client.post("/api/omr", files={"image": ("bad.png", b"CRASH" + PNG, "image/png")})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail.startswith("악보 인식 프로그램에 문제가 생겼어요.")
    assert "UnicodeDecodeError" in detail


def test_cors_for_hosted_app():
    r = client.options(
        "/api/omr",
        headers={"Origin": "https://example.github.io", "Access-Control-Request-Method": "POST"},
    )
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") in ("*", "https://example.github.io")


def test_worker_keeps_the_engine_running(monkeypatch):
    from server import app as server_app

    worker = server_app.HomrWorker([sys.executable, str(HERE / "fake_worker.py")])
    monkeypatch.setattr(server_app, "WORKER", worker)
    try:
        for _ in range(2):
            r = client.post("/api/omr", files={"image": ("page.png", PNG, "image/png")})
            assert r.status_code == 200, r.text
            assert r.json()["worker"] is True
        assert worker.jobs == 2
        first = worker.proc.pid
        # 인식 실패는 작업자가 그대로 알려 준다 (작업자는 계속 산다)
        r = client.post("/api/omr", files={"image": ("bad.png", b"FAIL" + PNG, "image/png")})
        assert r.status_code == 422
        assert worker.proc.pid == first
    finally:
        worker.close()


def test_worker_crash_falls_back_and_restarts(monkeypatch):
    from server import app as server_app

    worker = server_app.HomrWorker([sys.executable, str(HERE / "fake_worker.py")])
    monkeypatch.setattr(server_app, "WORKER", worker)
    try:
        r = client.post("/api/omr", files={"image": ("die.png", b"DIE" + PNG, "image/png")})
        # 작업자가 죽어도 따로 실행해서 결과를 낸다 (fake_homr 는 DIE 를 보통 그림처럼 처리)
        assert r.status_code == 200, r.text
        assert r.json()["worker"] is False
        r = client.post("/api/omr", files={"image": ("page.png", PNG, "image/png")})
        assert r.status_code == 200
        assert worker.proc is not None and worker.proc.poll() is None  # 다시 켜졌다
    finally:
        worker.close()
