# -*- mode: python ; coding: utf-8 -*-
# PyInstaller 설정: Python + homr(인식 모델 포함) + 서버 + 웹 앱을 한 폴더로 묶는다.
# python desktop/build.py 가 이 파일로 빌드한다.
import os
import sys

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, '..'))
IS_WIN = sys.platform == 'win32'
IS_MAC = sys.platform == 'darwin'
VERSION = os.environ.get('READ_CLASSIC_VERSION', '1.0.0')
ICON = os.path.join(SPECPATH, 'icons', 'read-classic.ico' if IS_WIN else 'read-classic.icns')
SKIP_ENGINES = ('openvino', 'paddle', 'pytorch', 'tensorrt', 'mnn')

datas = [(os.path.join(ROOT, 'dist'), 'web')]
datas += collect_data_files('homr')  # 악보 인식 모델 (*.onnx)
datas += collect_data_files('rapidocr')  # 제목 글자 인식 모델과 설정
datas += collect_data_files('musicxml')  # MusicXML 스키마 (악보 생성에 필요)

hiddenimports = (
    collect_submodules('uvicorn')
    + collect_submodules('homr')
    + collect_submodules('rapidocr', filter=lambda name: not any(e in name for e in SKIP_ENGINES))
    + ['python_multipart', 'multipart']
)

a = Analysis(
    [os.path.join(SPECPATH, 'launcher.py')],
    pathex=[ROOT],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=['tkinter', 'matplotlib', 'torch', 'tensorflow', 'paddle', 'openvino', 'IPython', 'pytest'],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    # 파이썬을 UTF-8 모드로 실행한다. 한국어 Windows 의 기본 인코딩(cp949)으로는
    # 악보 인식 엔진이 쓰는 UTF-8 자료 파일을 읽지 못해 인식이 멈춘다.
    # (묶음 프로그램은 PYTHONUTF8 환경 변수를 무시하므로 여기서 켜야 한다)
    [('X utf8', None, 'OPTION')],
    exclude_binaries=True,
    name='read-classic',
    # Windows·Mac 은 검은 창 없이 뒤에서 돈다 (끄기: 앱 설정 → 앱 끄기). Linux 는 터미널에서 쓰기 좋게 창을 둔다.
    console=not (IS_WIN or IS_MAC),
    icon=ICON if (IS_WIN or IS_MAC) else None,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, upx=False, name='ReadClassic')
if IS_MAC:
    app = BUNDLE(
        coll,
        name='Read Classic.app',
        icon=ICON,
        bundle_identifier='io.github.saltsongsun.readclassic',
        version=VERSION,
        info_plist={
            'CFBundleDisplayName': 'Read Classic',
            'CFBundleShortVersionString': VERSION,
            'LSUIElement': True,  # Dock 아이콘 없이 뒤에서 실행 (브라우저가 화면)
            'LSMinimumSystemVersion': '11.0',
        },
    )
