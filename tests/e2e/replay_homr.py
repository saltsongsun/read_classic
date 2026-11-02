"""e2e 용 homr 대역: 이 저장소의 tests/omr/ 에 저장해 둔 실제 homr 인식 결과를 그대로 돌려준다.
(예제 사진 tests/omr/ode-to-joy-photo.jpg 를 homr 0.7.0 으로 인식한 결과)"""
import shutil
import sys
from pathlib import Path

if "--help" in sys.argv:
    print("usage: homr [--write-staff-positions] image")
    sys.exit(0)
image = Path([a for a in sys.argv[1:] if not a.startswith("--")][0])
if image.stat().st_size < 5000:
    # 아주 작은(빈) 그림은 실제 homr 처럼 실패한다 — 여러 쪽 중 한 쪽만 실패하는 경우 시험용
    print("Exception: No staffs found")
    sys.exit(1)
src = Path(__file__).resolve().parents[1] / "omr" / "ode-to-joy-photo"
shutil.copy(src.with_suffix(".musicxml"), image.with_suffix(".musicxml"))
if "--write-staff-positions" in sys.argv:
    shutil.copy(src.with_suffix(".txt"), image.with_suffix(".txt"))
