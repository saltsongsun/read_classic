# -*- mode: python ; coding: utf-8 -*-
# PyInstaller 설정: Python + homr(인식 모델 포함) + 서버 + 웹 앱을 한 폴더로 묶는다.
# python desktop/build.py 가 이 파일로 빌드한다.
import os

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = os.path.abspath(os.path.join(SPECPATH, '..'))
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
    [],
    exclude_binaries=True,
    name='read-classic',
    console=True,  # 검은 창: 실행 상태를 보여 주고, 닫으면 종료된다
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, upx=False, name='ReadClassic')
