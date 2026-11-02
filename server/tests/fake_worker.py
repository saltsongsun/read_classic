"""테스트용 작업자 대역: server/homr_worker.py 와 같은 방식으로 주고받고, 일은 fake_homr.py 로 한다."""
import contextlib
import io
import json
import runpy
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    args = json.loads(line)["args"]
    image = Path([a for a in args if not a.startswith("--")][0])
    if image.read_bytes().startswith(b"DIE"):
        sys.exit(3)  # 작업자가 갑자기 죽는 경우
    buf = io.StringIO()
    code = 0
    sys.argv = ["homr", *args]
    with contextlib.redirect_stdout(buf):
        try:
            runpy.run_path(str(HERE / "fake_homr.py"), run_name="__main__")
        except SystemExit as e:
            code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
    print(json.dumps({"code": code, "log": buf.getvalue()}), flush=True)
