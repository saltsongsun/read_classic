"""테스트용 대역: 실제 homr 대신 입력 이미지 옆에 정해진 MusicXML 을 쓴다 (인식 품질과 무관한 배선 시험용)."""
import sys
from pathlib import Path

if "--help" in sys.argv:
    print("usage: homr [--write-staff-positions] [--no-title] image")
    sys.exit(0)
args = [a for a in sys.argv[1:] if not a.startswith("--")]
if not args:
    sys.exit("no image")
img = Path(args[0])
if img.read_bytes().startswith(b"FAIL"):
    print("Processing", img)
    print("ValueError: no staffs found")
    sys.exit(1)
xml = Path(__file__).with_name("page.musicxml").read_text(encoding="utf-8")
img.with_suffix(".musicxml").write_text(xml, encoding="utf-8")
if "--write-staff-positions" in sys.argv:
    img.with_suffix(".txt").write_text("1 0.5 0.2 0.8 0.1\n1 0.5 0.5 0.8 0.1\n", encoding="utf-8")
