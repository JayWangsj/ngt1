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
#define AppName "NGTManager"
#define AppId "{{E7B1C553-4F5A-4239-A4C2-7DCA1DC27121}"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=NGT
DefaultDirName={localappdata}\NGTManager
UninstallFilesDir={localappdata}\NGTManager\uninstall
UsePreviousAppDir=no
DisableDirPage=yes
DisableStartupPrompt=yes
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=ngt-studio-windows-setup-v{#AppVersion}
SetupIconFile={#IconPath}
PrivilegesRequired=lowest
SetupLogging=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/normal
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
UninstallDisplayName={#AppName}
UninstallDisplayIcon={localappdata}\NGTManager\assets\ngt-studio.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#PackageDirectory}\*"; DestDir: "{tmp}\NGTStudioPackage"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autodesktop}\{#AppName}"; Filename: "{localappdata}\NGTManager\tools\NGTManager.exe"; Parameters: "open"; WorkingDir: "{localappdata}\NGTManager"; IconFilename: "{localappdata}\NGTManager\assets\ngt-studio.ico"
Name: "{autoprograms}\{#AppName}"; Filename: "{localappdata}\NGTManager\tools\NGTManager.exe"; Parameters: "open"; WorkingDir: "{localappdata}\NGTManager"; IconFilename: "{localappdata}\NGTManager\assets\ngt-studio.ico"

[InstallDelete]
Type: files; Name: "{autodesktop}\NGT 工作室管理系统.url"
Type: files; Name: "{autoprograms}\NGT 工作室管理系统.url"

[Run]
Filename: "{localappdata}\NGTManager\tools\NGTManager.exe"; Parameters: "open"; Description: "Open {#AppName}"; Flags: runhidden postinstall nowait skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\NGTManager\releases"
Type: filesandordirs; Name: "{localappdata}\NGTManager\tools"
Type: filesandordirs; Name: "{localappdata}\NGTManager\assets"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  ManagerPath: String;
  PackagePath: String;
  ResultPath: String;
  ResultMessage: String;
  ResultLines: TArrayOfString;
  ResultIndex: Integer;
  Parameters: String;
  Operation: String;
  UpdateId: String;
begin
  if CurStep <> ssPostInstall then
    exit;

  ManagerPath := ExpandConstant('{tmp}\NGTStudioPackage\tools\NGTManager.exe');
  PackagePath := ExpandConstant('{tmp}\NGTStudioPackage');
  ResultPath := ExpandConstant('{tmp}\NGTManager-setup-result.txt');
  DeleteFile(ResultPath);
  Operation := 'install';
  UpdateId := ExpandConstant('{param:NGTUpdateId|}');
  if UpdateId <> '' then
    Operation := 'update';
  Parameters := Operation + ' "' + PackagePath + '"';
  if UpdateId <> '' then
    Parameters := Parameters + ' ' + UpdateId;
  Parameters := Parameters + ' --result-file "' + ResultPath + '"';
  WizardForm.StatusLabel.Caption := 'Checking the system and preparing NGTManager…';
  ResultCode := -1;
  if (not Exec(ManagerPath, Parameters, PackagePath, SW_HIDE, ewWaitUntilTerminated, ResultCode)) or
    (ResultCode <> 0) then
  begin
    ResultMessage := 'No detailed NGTManager error was written.' + #13#10 +
      'Open %TEMP% and find the Inno Setup Log file matching this installation time.';
    if LoadStringsFromFile(ResultPath, ResultLines) and
      (GetArrayLength(ResultLines) > 1) then
    begin
      ResultMessage := ResultLines[1];
      for ResultIndex := 2 to GetArrayLength(ResultLines) - 1 do
        ResultMessage := ResultMessage + #13#10 + ResultLines[ResultIndex];
    end;
    if not WizardSilent then
      MsgBox('NGTManager could not complete installation.' + #13#10 + ResultMessage, mbError, MB_OK);
    RaiseException('NGTManager installation failed. Exit code: ' + IntToStr(ResultCode) + #13#10 + ResultMessage);
  end;
end;
function InitializeUninstall(): Boolean;
var
  ManagerPath: String;
  InstallRoot: String;
  ResultCode: Integer;
begin
  Result := True;
  InstallRoot := ExpandConstant('{localappdata}\NGTManager');
  ManagerPath := InstallRoot + '\tools\NGTManager.exe';
  if not FileExists(ManagerPath) then
  begin
    if not UninstallSilent then
      MsgBox('NGTManager cannot verify a safe shutdown because its manager executable is missing. Preserve the data folder and repair the installation first.', mbError, MB_OK);
    Result := False;
    exit;
  end;

  ResultCode := -1;
  if (not Exec(ManagerPath, 'uninstall', InstallRoot, SW_HIDE, ewWaitUntilTerminated, ResultCode)) or
    (ResultCode <> 0) then
  begin
    if not UninstallSilent then
      MsgBox('NGTManager could not stop safely. Close the active operation and retry uninstall.', mbError, MB_OK);
    Result := False;
  end;
end;
