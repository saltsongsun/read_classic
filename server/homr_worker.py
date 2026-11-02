"""
악보 인식 엔진(homr)을 한 번 켜 두고 여러 쪽을 차례로 인식하는 작업자.

쪽마다 프로그램을 새로 켜면 파이썬과 라이브러리(numpy, OpenCV, onnxruntime, homr)를 매번 다시 읽느라
쪽당 몇 초씩 더 걸린다. 이 작업자는 한 번만 읽어 두고, 표준 입력으로 받은 일을 하나씩 처리한다.

  주고받기 (한 줄에 JSON 하나):
    → {"args": ["--write-staff-positions", "/tmp/omr-x/page.jpg"]}
    ← {"code": 0, "log": "…homr 가 남긴 기록…"}

homr 나 다른 라이브러리가 print 로 표준 출력에 쓰더라도 주고받는 줄이 섞이지 않게,
표준 출력은 기록(stderr)으로 돌리고 주고받기에는 따로 떼어 둔 원래 출력을 쓴다.

  python -m server.homr_worker      (개발·서버용)
  read-classic --homr-worker        (노트북 앱: 실행 파일이 이 모드로 자신을 부른다)
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import traceback

LOG_LIMIT = 6000


def serve() -> None:
    # 주고받기용 출력을 따로 떼어 두고, 원래 표준 출력(1번)은 오류 출력(2번)으로 돌린다
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    from homr.main import main as homr_main  # 한 번만 읽는다

    proto.write(json.dumps({"ready": True}) + "\n")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
            args = [str(a) for a in job["args"]]
        except Exception as e:
            proto.write(json.dumps({"code": 2, "log": f"bad job: {e}"}) + "\n")
            continue
        buf = io.StringIO()
        code = 0
        sys.argv = ["homr", *args]
        with contextlib.redirect_stderr(buf), contextlib.redirect_stdout(buf):
            try:
                homr_main()
            except SystemExit as e:
                code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
            except BaseException:
                traceback.print_exc()
                code = 1
        log = buf.getvalue()
        sys.stderr.write(log)
        proto.write(json.dumps({"code": code, "log": log[-LOG_LIMIT:]}, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    serve()
