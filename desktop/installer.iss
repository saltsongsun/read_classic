; Windows 설치 파일 (Inno Setup 6). desktop/build.py 가 ISCC 로 만든다.
; 관리자 권한 없이 사용자 폴더에 설치하고, 바탕화면·시작 메뉴에 아이콘을 만든다.
#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif

[Setup]
AppId=ReadClassic
AppName=Read Classic
AppVersion={#AppVersion}
AppVerName=Read Classic {#AppVersion}
AppPublisher=Read Classic
DefaultDirName={localappdata}\Programs\ReadClassic
DefaultGroupName=Read Classic
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputDir=out
OutputBaseFilename=ReadClassic-Windows-Setup
SetupIconFile=icons\read-classic.ico
UninstallDisplayIcon={app}\read-classic.exe
UninstallDisplayName=Read Classic
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=force
RestartApplications=no

[Languages]
#if FileExists(CompilerPath + "Languages\Korean.isl")
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
#else
Name: "english"; MessagesFile: "compiler:Default.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "바탕화면에 Read Classic 아이콘 만들기"

[InstallDelete]
; 새 판으로 바꿀 때 예전 파일이 섞이지 않게
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "build\dist\ReadClassic\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Read Classic"; Filename: "{app}\read-classic.exe"
Name: "{autodesktop}\Read Classic"; Filename: "{app}\read-classic.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\read-classic.exe"; Description: "지금 Read Classic 열기"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /T /IM read-classic.exe"; Flags: runhidden; RunOnceId: "StopReadClassic"
