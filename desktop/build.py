"""
노트북용 Read Classic 묶음 만들기.

  npm ci && npm run build                    # 웹 앱 (dist/)
  pip install -r desktop/requirements.txt
  homr --init                                # 인식 모델 내려받기 (빌드하는 컴퓨터에서 한 번)
  python desktop/build.py                    # → desktop/out/ReadClassic-<운영체제>-<cpu>.zip

만든 zip 을 풀고 read-classic(.exe) 를 실행하면 된다. 실행할 때는 인터넷이 필요 없다.
"""

from __future__ import annotations

import platform
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
OUT = HERE / "out"

GUIDE = """Read Classic · 악보 따라가기 (노트북용)

실행: 이 폴더의 {exe} 를 더블클릭하세요.
  - 검은 창이 뜨고 잠시 후 브라우저에 앱이 열립니다 (http://localhost:47800).
  - 검은 창을 닫으면 꺼집니다. 다시 쓰려면 다시 더블클릭하세요.
  - 인터넷이 없어도 사진·PDF 악보 인식과 연주 따라가기가 모두 됩니다.

처음 실행할 때
{first_run}

저장된 악보는 이 컴퓨터의 브라우저에 남습니다. 같은 브라우저로 열어 주세요.
지우려면 이 폴더를 통째로 삭제하면 됩니다.
"""

FIRST_RUN = {
    "Windows": "  - \"Windows의 PC 보호\" 창이 나오면 [추가 정보] → [실행]을 누르세요.\n"
    "  - 방화벽 허용을 물으면 [취소]해도 됩니다 (이 컴퓨터 안에서만 씁니다).",
    "Darwin": "  - \"확인되지 않은 개발자\" 경고가 나오면, 터미널에서 아래를 한 번 실행한 뒤 다시 더블클릭하세요.\n"
    "      xattr -dr com.apple.quarantine <이 폴더를 터미널로 끌어다 놓기>",
    "Linux": "  - 터미널에서 ./read-classic 로 실행해도 됩니다.",
}


def main() -> None:
    web = ROOT / "dist" / "index.html"
    if not web.exists():
        sys.exit("웹 앱이 없습니다. 먼저 npm run build 를 실행하세요.")
    import homr  # noqa: F401 — 설치 확인

    models = list(Path(homr.__file__).parent.rglob("*.onnx"))
    if len(models) < 3:
        sys.exit("homr 인식 모델이 없습니다. 먼저 homr --init 을 실행하세요.")

    work = HERE / "build"
    subprocess.run(
        [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", str(work / "dist"),
         "--workpath", str(work / "tmp"), str(HERE / "read_classic.spec")],
        check=True,
        cwd=ROOT,
    )
    app_dir = work / "dist" / "ReadClassic"
    system = platform.system()
    exe = "read-classic.exe" if system == "Windows" else "read-classic"
    (app_dir / "사용법.txt").write_text(GUIDE.format(exe=exe, first_run=FIRST_RUN.get(system, "")), encoding="utf-8")

    machine = platform.machine().lower().replace("amd64", "x64").replace("x86_64", "x64").replace("aarch64", "arm64")
    name = {"Windows": "windows", "Darwin": "macos", "Linux": "linux"}.get(system, system.lower())
    OUT.mkdir(exist_ok=True)
    zip_path = OUT / f"ReadClassic-{name}-{machine}.zip"
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for f in sorted(app_dir.rglob("*")):
            arc = Path("ReadClassic") / f.relative_to(app_dir)
            if f.is_symlink() or f.is_dir():
                continue
            info = zipfile.ZipInfo.from_file(f, arc)
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(f, "rb") as src:
                z.writestr(info, src.read())
    size = zip_path.stat().st_size / 1024 / 1024
    print(f"만들었습니다: {zip_path} ({size:.0f}MB)")
    print(f"실행 파일: {app_dir / exe}")
    shutil.rmtree(work / "tmp", ignore_errors=True)


if __name__ == "__main__":
    main()
