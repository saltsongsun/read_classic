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
    assert "no staffs found" in r.json()["detail"]


def test_cors_for_hosted_app():
    r = client.options(
        "/api/omr",
        headers={"Origin": "https://example.github.io", "Access-Control-Request-Method": "POST"},
    )
    assert r.status_code == 200
    assert r.headers.get("access-control-allow-origin") in ("*", "https://example.github.io")
