"""
노트북용 Read Classic 설치 파일 만들기.

  npm ci && npm run build                    # 웹 앱 (dist/)
  pip install -r desktop/requirements.txt
  homr --init                                # 인식 모델 내려받기 (빌드하는 컴퓨터에서 한 번)
  python desktop/build.py                    # → desktop/out/

만들어지는 것
  Windows  ReadClassic-Windows-Setup.exe   설치 파일 (Inno Setup 6 필요: choco install innosetup)
  Mac      ReadClassic-Mac.dmg             열어서 Read Classic 을 응용 프로그램 폴더로 끌어다 놓기
  Linux    ReadClassic-Linux.zip           풀고 ./read-classic

실행할 때는 인터넷이 필요 없다. 판 번호는 환경 변수 READ_CLASSIC_VERSION (기본 1.0.0).
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / "out"
WORK = HERE / "build"
SYSTEM = platform.system()
VERSION = os.environ.get("READ_CLASSIC_VERSION", "1.0.0")

MAC_GUIDE = """Read Classic 설치

1. 옆의 Read Classic 아이콘을 "Applications(응용 프로그램)" 폴더로 끌어다 놓으세요.
2. 응용 프로그램 폴더에서 Read Classic 을 여세요. 잠시 뒤 브라우저에 앱이 열립니다.

처음 열 때 "확인할 수 없어 열 수 없습니다" 같은 경고가 나오면:
  시스템 설정 → 개인정보 보호 및 보안 → 아래쪽의 [그래도 열기] 를 누른 뒤 다시 여세요.

끄기: 앱 오른쪽 위 설정(조절 아이콘) → [앱 끄기]
인터넷이 없어도 사진·PDF 악보 인식과 연주 따라가기가 모두 됩니다.
"""

LINUX_GUIDE = """Read Classic (Linux)

실행: 이 폴더에서 ./read-classic  → 브라우저에 http://localhost:47800 이 열립니다.
끄기: 터미널에서 Ctrl+C, 또는 앱 설정 → [앱 끄기]
인터넷이 없어도 사진·PDF 악보 인식과 연주 따라가기가 모두 됩니다.
"""


def check_inputs() -> None:
    if not (ROOT / "dist" / "index.html").exists():
        sys.exit("웹 앱이 없습니다. 먼저 npm run build 를 실행하세요.")
    import homr

    if len(list(Path(homr.__file__).parent.rglob("*.onnx"))) < 3:
        sys.exit("homr 인식 모델이 없습니다. 먼저 homr --init 을 실행하세요.")


def pyinstaller() -> None:
    subprocess.run(
        [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", str(WORK / "dist"),
         "--workpath", str(WORK / "tmp"), str(HERE / "read_classic.spec")],
        check=True,
        cwd=ROOT,
        env={**os.environ, "READ_CLASSIC_VERSION": VERSION},
    )
    shutil.rmtree(WORK / "tmp", ignore_errors=True)


def find_iscc() -> str | None:
    found = shutil.which("iscc") or shutil.which("ISCC")
    if found:
        return found
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        if base:
            for sub in ("Inno Setup 6", r"Programs\Inno Setup 6"):
                cand = Path(base) / sub / "ISCC.exe"
                if cand.exists():
                    return str(cand)
    return None


def windows_installer() -> Path:
    iscc = find_iscc()
    if not iscc:
        sys.exit("Inno Setup 6 의 ISCC.exe 를 찾지 못했습니다 (choco install innosetup).")
    subprocess.run([iscc, f"/DAppVersion={VERSION}", str(HERE / "installer.iss")], check=True, cwd=HERE)
    return OUT / "ReadClassic-Windows-Setup.exe"


def mac_dmg() -> Path:
    stage = WORK / "dmg"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    # ditto: 앱 묶음 안의 심볼릭 링크와 서명을 그대로 복사
    subprocess.run(["ditto", str(WORK / "dist" / "Read Classic.app"), str(stage / "Read Classic.app")], check=True)
    (stage / "Applications").symlink_to("/Applications")
    (stage / "설치 방법.txt").write_text(MAC_GUIDE, encoding="utf-8")
    dmg = OUT / "ReadClassic-Mac.dmg"
    dmg.unlink(missing_ok=True)
    subprocess.run(
        ["hdiutil", "create", "-volname", "Read Classic", "-srcfolder", str(stage), "-ov", "-format", "UDZO", str(dmg)],
        check=True,
    )
    shutil.rmtree(stage, ignore_errors=True)
    return dmg


def linux_zip() -> Path:
    app_dir = WORK / "dist" / "ReadClassic"
    (app_dir / "사용법.txt").write_text(LINUX_GUIDE, encoding="utf-8")
    zip_path = OUT / "ReadClassic-Linux.zip"
    zip_path.unlink(missing_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f in sorted(app_dir.rglob("*")):
            if f.is_symlink() or f.is_dir():
                continue
            info = zipfile.ZipInfo.from_file(f, Path("ReadClassic") / f.relative_to(app_dir))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, f.read_bytes())
    return zip_path


def main() -> None:
    check_inputs()
    OUT.mkdir(exist_ok=True)
    pyinstaller()
    if SYSTEM == "Windows":
        result = windows_installer()
    elif SYSTEM == "Darwin":
        result = mac_dmg()
    else:
        result = linux_zip()
    print(f"만들었습니다: {result} ({result.stat().st_size / 1024 / 1024:.0f}MB)")


if __name__ == "__main__":
    main()
