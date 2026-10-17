#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef PackageDirectory
  #error PackageDirectory is required
#endif
#ifndef IconPath
  #error IconPath is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifndef InstallerSupportDirectory
  #error InstallerSupportDirectory is required
#endif

#define AppName "NGT 工作室管理系统"
#define AppId "{{D7F74E80-B49C-4C3D-B6FC-18C04DAA9D31}"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=NGT
DefaultDirName={localappdata}\NGT
UninstallFilesDir={localappdata}\NGT\uninstall
UsePreviousAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=ngt-studio-windows-setup-v{#AppVersion}
SetupIconFile={#IconPath}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
UninstallDisplayName={#AppName}
UninstallDisplayIcon={localappdata}\NGT\assets\ngt-studio.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#PackageDirectory}\*"; DestDir: "{tmp}\NGTStudioPackage"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#InstallerSupportDirectory}\prepare-windows-studio-install.ps1"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#InstallerSupportDirectory}\windows-studio-install-coordination.ps1"; DestDir: "{tmp}"; Flags: dontcopy

[Icons]
Name: "{autodesktop}\NGT 工作室管理系统"; Filename: "http://127.0.0.1:3000"; WorkingDir: "{app}"; IconFilename: "{localappdata}\NGT\assets\ngt-studio.ico"
Name: "{autoprograms}\NGT 工作室管理系统"; Filename: "http://127.0.0.1:3000"; WorkingDir: "{app}"; IconFilename: "{localappdata}\NGT\assets\ngt-studio.ico"

[Run]
Filename: "http://127.0.0.1:3000"; Description: "打开 NGT 工作室管理系统"; Flags: shellexec postinstall nowait skipifsilent

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{localappdata}\NGT\service\uninstall-windows-studio.ps1"""; Flags: runhidden waituntilterminated; RunOnceId: "StopNgtStudio"

[Code]
var
  InstallFilesStartedAt: Longint;

function GetTickCount: Longint;
  external 'GetTickCount@kernel32.dll stdcall';

procedure WriteInstallStage(const Stage, Detail: String);
var
  LogPath: String;
  Line: String;
begin
  LogPath := ExpandConstant('{localappdata}\NGT\install-stages.log');
  Line := IntToStr(GetTickCount) + ' ' + Detail + ' ' + Stage + ' ' + #13#10;
  SaveStringToFile(LogPath, Line, True);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  PowerShellPath: String;
  Parameters: String;
  PreflightLogPath: String;
begin
  ExtractTemporaryFile('prepare-windows-studio-install.ps1');
  ExtractTemporaryFile('windows-studio-install-coordination.ps1');
  PowerShellPath := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  PreflightLogPath := ExpandConstant('{localappdata}\NGT\install-preflight.log');
  Parameters := '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\prepare-windows-studio-install.ps1') +
    '" -InstallRoot "' + ExpandConstant('{localappdata}\NGT') +
    '" -TargetVersion "{#AppVersion}" -LogPath "' + PreflightLogPath + '"';
  if (not Exec(PowerShellPath, Parameters, '', SW_HIDE, ewWaitUntilTerminated, ResultCode)) or
    (ResultCode <> 0) then
  begin
    Result := '安装前安全检查失败。请查看日志：' + PreflightLogPath;
  end
  else
    Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  PowerShellPath: String;
  Parameters: String;
begin
  if CurStep = ssInstall then
  begin
    InstallFilesStartedAt := GetTickCount;
    WriteInstallStage('install-files', 'START');
    exit;
  end;

  if CurStep <> ssPostInstall then
    exit;

  WriteInstallStage('install-files', 'COMPLETE durationSeconds=' +
    FloatToStr((GetTickCount - InstallFilesStartedAt) / 1000));
  WizardForm.StatusLabel.Caption := '正在验证安装模式、备份数据并执行数据库迁移…';
  PowerShellPath := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
  Parameters := '-NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\NGTStudioPackage\scripts\install-windows-studio-bootstrap.ps1') +
    '" -DataRoot "' + ExpandConstant('{localappdata}\NGT\data-store') +
    '" -InstallRoot "' + ExpandConstant('{localappdata}\NGT') +
    '" -LogPath "' + ExpandConstant('{localappdata}\NGT\install.log') + '"';

  if (not Exec(PowerShellPath, Parameters, ExpandConstant('{tmp}\NGTStudioPackage'),
    SW_HIDE, ewWaitUntilTerminated, ResultCode)) or (ResultCode <> 0) then
  begin
    if not WizardSilent then
      MsgBox('系统初始化失败。详细原因已保存到：' + #13#10 +
        ExpandConstant('{localappdata}\NGT\install.log'),
        mbError, MB_OK);
    RaiseException('系统初始化失败，退出代码：' + IntToStr(ResultCode));
  end;
end;
