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


def speed_up() -> str:
    """homr 0.7.0 을 더 빠르게 돌린다 (결과 악보는 같다 — 제목 글자만 비게 된다).

    재 보니 빽빽한 피아노 한 쪽(오선 12개)이 4코어에서 20.8초 → 12.1초.
    - 오선을 한 줄씩 차례로 읽던 것을 여러 줄 동시에 읽는다. 줄 읽기(디코더)는 작은 행렬 계산이 이어져서
      한 줄에 코어 여럿을 쓰는 것보다 코어 하나씩 여러 줄이 훨씬 효율적이다. 줄마다 따로 IO 바인딩을 쓴다.
    - 곡 제목 글자 인식(rapidocr)을 하지 않는다. 앱은 파일 이름을 제목으로 쓰고, 이 작업이 CPU 를 나눠 먹는다.
    homr 안쪽을 건드리므로 맞지 않으면 아무것도 바꾸지 않고 원래대로 돈다.
    """
    try:
        import copy
        import threading
        from concurrent.futures import Future, ThreadPoolExecutor

        import onnxruntime as ort

        import homr.main as hm
        import homr.staff_parsing as sp
        import homr.staff_parsing_tromr as spt
        import homr.transformer.decoder_inference as di
        from homr.transformer.staff2score import Staff2Score

        workers = int(os.environ.get("READ_CLASSIC_OMR_THREADS") or max(1, min(6, (os.cpu_count() or 2) - 1)))

        # 1) 디코더 세션만 코어 하나씩 (다른 모델은 그대로)
        class DecoderSession(ort.InferenceSession):
            def __init__(self, path, *args, **kwargs):  # type: ignore[no-untyped-def]
                so = kwargs.pop("sess_options", None) or ort.SessionOptions()
                so.intra_op_num_threads = 1
                super().__init__(path, so, *args, **kwargs)

        class OrtForDecoder:
            def __getattr__(self, name):  # type: ignore[no-untyped-def]
                return DecoderSession if name == "InferenceSession" else getattr(ort, name)

        if workers > 1:
            di.ort = OrtForDecoder()  # type: ignore[assignment]

        # 2) 줄마다 따로 IO 바인딩을 쓰는 모델 사본 (세션은 같이 쓴다)
        local = threading.local()

        def model_for_thread(config):  # type: ignore[no-untyped-def]
            if spt.inference is None:
                spt.inference = Staff2Score(config)
            m = getattr(local, "model", None)
            if m is None:
                base = spt.inference
                m = copy.copy(base)
                m.encoder = copy.copy(base.encoder)
                m.encoder.io_binding = base.encoder.encoder.io_binding()
                m.decoder = copy.copy(base.decoder)
                m.decoder.io_binding = base.decoder.net.io_binding()
                local.model = m
            return m

        def predict_best(org_image, staff, config):  # type: ignore[no-untyped-def]
            result = model_for_thread(config).predict(org_image)
            return result if staff.is_grandstaff else [r for r in result if r.position != "lower"]

        original_parse_image = sp.parse_staff_image

        def parse_staffs(debug, staffs, image, config, selected_staff=-1):  # type: ignore[no-untyped-def]
            staffs = sp._ensure_same_number_of_staffs(staffs, image)
            voices_n = sp._get_number_of_voices(staffs)
            regions = sp.StaffRegions(staffs)
            jobs = []
            for voice in range(voices_n):
                for staff in [s.staffs[voice] for s in staffs]:
                    jobs.append((voice, len(jobs), staff))
            if selected_staff >= 0:
                jobs = [j for j in jobs if j[1] == selected_staff]
            with ThreadPoolExecutor(workers) as ex:
                results = list(ex.map(lambda j: original_parse_image(debug, j[1], j[2], image, regions, config), jobs))
            voices: list[list] = [[] for _ in range(voices_n)]
            for (voice, _, _), r in zip(jobs, results, strict=True):
                if len(r) == 0:
                    continue
                r.append(sp.EncodedSymbol("newline"))
                voices[voice].extend(r)
            return [sp.remove_duplicated_symbols(v) for v in voices]

        if workers > 1:
            spt.predict_best = predict_best
            sp.parse_staff_tromr = lambda staff, staff_image, config: predict_best(staff_image, staff, config)
            sp.parse_staffs = parse_staffs
            hm.parse_staffs = parse_staffs

        # 3) 제목 글자 인식 끄기
        def no_title(*_args, **_kwargs):  # type: ignore[no-untyped-def]
            f: Future = Future()
            f.set_result("")
            return f

        hm.detect_title = no_title
        return f"빠르게: 오선 {workers}줄 동시에, 제목 인식 끔"
    except Exception as e:  # homr 가 바뀌어 맞지 않으면 원래대로
        return f"빠르게 하기를 쓰지 못함 ({type(e).__name__}: {e})"


def serve() -> None:
    # 주고받기용 출력을 따로 떼어 두고, 원래 표준 출력(1번)은 오류 출력(2번)으로 돌린다
    proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    from homr.main import main as homr_main  # 한 번만 읽는다

    if not os.environ.get("READ_CLASSIC_OMR_PLAIN"):
        print(speed_up(), file=sys.stderr, flush=True)

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
