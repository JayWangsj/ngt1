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
#ifndef PackageBytes
  #error PackageBytes is required
#endif
#ifndef PackageFileCount
  #error PackageFileCount is required
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
Name: "italian"; MessagesFile: "compiler:Languages\Italian.isl"
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"

[Files]
Source: "{#PackageDirectory}\*"; DestDir: "{tmp}\ngt-package"; Excludes: "\studio-release.json"; Flags: deleteafterinstall ignoreversion recursesubdirs createallsubdirs
Source: "{#PackageDirectory}\studio-release.json"; DestDir: "{tmp}\ngt-package"; Flags: deleteafterinstall ignoreversion; AfterInstall: InstallExtractedPackage

[Icons]
Name: "{autodesktop}\{#AppName}"; Filename: "{localappdata}\NGTManager\tools\NGTManager.exe"; Parameters: "open"; WorkingDir: "{localappdata}\NGTManager"; IconFilename: "{localappdata}\NGTManager\assets\ngt-studio.ico"
Name: "{autoprograms}\{#AppName}"; Filename: "{localappdata}\NGTManager\tools\NGTManager.exe"; Parameters: "open"; WorkingDir: "{localappdata}\NGTManager"; IconFilename: "{localappdata}\NGTManager\assets\ngt-studio.ico"

[Run]
Filename: "{localappdata}\NGTManager\tools\NGTManager.exe"; Parameters: "open"; Description: "{cm:OpenNGTManager}"; Flags: postinstall nowait skipifsilent

[CustomMessages]
english.OpenNGTManager=Open NGTManager
italian.OpenNGTManager=Apri NGTManager
chinesesimplified.OpenNGTManager=打开 NGTManager

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\NGTManager\releases"
Type: filesandordirs; Name: "{localappdata}\NGTManager\tools"
Type: filesandordirs; Name: "{localappdata}\NGTManager\assets"

[Code]
type
  TWindowsPoint = record
    X: LongInt;
    Y: LongInt;
  end;
  TWindowsMessage = record
    Wnd: HWND;
    Message: UINT;
    WParam: LongWord;
    LParam: LongInt;
    Time: DWORD;
    Point: TWindowsPoint;
  end;

var
  AttemptId: String;
  ResultPath: String;
  CancelPath: String;
  ProgressPath: String;
  ProcessIdPath: String;
  LastProgressLine: String;
  CurrentPhase: String;
  CoreRunning: Boolean;
  CoreCommitted: Boolean;
  CancelRequested: Boolean;
  PrepareSucceeded: Boolean;
  AttemptStartTick: Int64;
  PostInstallReached: Boolean;
  CancelWithoutPrompt: Boolean;
  InstallCard: TPanel;
  InstallBrandLabel: TNewStaticText;
  InstallVersionLabel: TNewStaticText;
  FailureDetails: TNewMemo;
  BrandProgressTrack: TPanel;
  BrandProgressFill: TPanel;
  FinishCard: TPanel;
  FinishBrandLabel: TNewStaticText;
  FinishVersionLabel: TNewStaticText;
  BrandProgressDeterminate: Boolean;
  BrandProgressPosition: Integer;
  BrandProgressAnimationTick: Int64;

const
  PBM_SETBARCOLOR = $0409;
  PBM_SETBKCOLOR = $2001;

function GetTickCount64: Int64;
  external 'GetTickCount64@kernel32.dll stdcall';

function OpenProcess(dwDesiredAccess: DWORD; bInheritHandle: BOOL;
  dwProcessId: DWORD): THandle;
  external 'OpenProcess@kernel32.dll stdcall';

function WaitForSingleObject(hHandle: THandle; dwMilliseconds: DWORD): DWORD;
  external 'WaitForSingleObject@kernel32.dll stdcall';

function CloseHandle(hObject: THandle): BOOL;
  external 'CloseHandle@kernel32.dll stdcall';

function PeekMessage(var lpMsg: TWindowsMessage; hWnd: HWND; wMsgFilterMin,
  wMsgFilterMax, wRemoveMsg: UINT): BOOL;
  external 'PeekMessageW@user32.dll stdcall';

function TranslateMessage(const lpMsg: TWindowsMessage): BOOL;
  external 'TranslateMessage@user32.dll stdcall';

function DispatchMessage(const lpMsg: TWindowsMessage): Longint;
  external 'DispatchMessageW@user32.dll stdcall';

function SendMessage(hWnd: HWND; Msg: UINT; wParam: LongWord;
  lParam: LongInt): LongInt;
  external 'SendMessageW@user32.dll stdcall';

function CreateRoundRectRgn(nLeftRect, nTopRect, nRightRect, nBottomRect,
  nWidthEllipse, nHeightEllipse: Integer): THandle;
  external 'CreateRoundRectRgn@gdi32.dll stdcall';

function SetWindowRgn(hWnd: HWND; hRgn: THandle; bRedraw: BOOL): Integer;
  external 'SetWindowRgn@user32.dll stdcall';

function UiText(const Chinese, Italian, English: String): String;
begin
  if ActiveLanguage = 'italian' then
    Result := Italian
  else if ActiveLanguage = 'chinesesimplified' then
    Result := Chinese
  else
    Result := English;
end;

procedure ApplyRoundedCard(Panel: TPanel);
var
  Region: THandle;
begin
  Region := CreateRoundRectRgn(0, 0, Panel.Width + 1, Panel.Height + 1,
    ScaleX(28), ScaleY(28));
  if Region <> 0 then
    SetWindowRgn(Panel.Handle, Region, True);
end;

procedure SetBrandProgress(Value, Total: Int64);
var
  AvailableWidth: Integer;
begin
  if (Total <= 0) or (Value < 0) then
  begin
    BrandProgressDeterminate := False;
    exit;
  end;
  if Value > Total then Value := Total;
  BrandProgressDeterminate := True;
  BrandProgressPosition := (Value * 1000) div Total;
  AvailableWidth := BrandProgressTrack.ClientWidth;
  BrandProgressFill.Left := 0;
  BrandProgressFill.Width := (AvailableWidth * BrandProgressPosition) div 1000;
end;

procedure SetBrandProgressActive;
begin
  BrandProgressDeterminate := False;
  BrandProgressAnimationTick := GetTickCount64;
end;

procedure AnimateBrandProgress;
var
  AvailableWidth: Integer;
  SegmentWidth: Integer;
  Travel: Integer;
begin
  if BrandProgressDeterminate or (BrandProgressTrack = nil) then exit;
  AvailableWidth := BrandProgressTrack.ClientWidth;
  SegmentWidth := AvailableWidth div 4;
  if SegmentWidth < ScaleX(48) then SegmentWidth := ScaleX(48);
  Travel := AvailableWidth + SegmentWidth;
  BrandProgressFill.Width := SegmentWidth;
  BrandProgressFill.Left := ((GetTickCount64 - BrandProgressAnimationTick) div 6) mod Travel - SegmentWidth;
end;

procedure ApplyDesktopTheme;
var
  CardWidth: Integer;
begin
  WizardForm.ClientWidth := ScaleX(680);
  WizardForm.ClientHeight := ScaleY(440);
  WizardForm.Color := clWhite;
  WizardForm.InnerPage.Color := clWhite;
  WizardForm.MainPanel.Visible := False;
  WizardForm.WizardBitmapImage.Visible := False;
  WizardForm.WizardSmallBitmapImage.Visible := False;

  CardWidth := WizardForm.InstallingPage.ClientWidth - ScaleX(48);
  InstallCard := TPanel.Create(WizardForm);
  InstallCard.Parent := WizardForm.InstallingPage;
  InstallCard.SetBounds(ScaleX(24), ScaleY(20), CardWidth,
    WizardForm.InstallingPage.ClientHeight - ScaleY(40));
  InstallCard.BevelOuter := bvNone;
  InstallCard.Color := $00F7FAFB;
  ApplyRoundedCard(InstallCard);

  InstallBrandLabel := TNewStaticText.Create(WizardForm);
  InstallBrandLabel.Parent := InstallCard;
  InstallBrandLabel.SetBounds(ScaleX(24), ScaleY(24), CardWidth - ScaleX(48), ScaleY(28));
  InstallBrandLabel.Caption := 'NGTManager';
  InstallBrandLabel.Font.Name := 'Arial';
  InstallBrandLabel.Font.Size := 14;
  InstallBrandLabel.Font.Style := [fsBold];
  InstallBrandLabel.Font.Color := $001F2729;

  InstallVersionLabel := TNewStaticText.Create(WizardForm);
  InstallVersionLabel.Parent := InstallCard;
  InstallVersionLabel.SetBounds(ScaleX(24), ScaleY(54), CardWidth - ScaleX(48), ScaleY(18));
  InstallVersionLabel.Caption := 'v{#AppVersion}';
  InstallVersionLabel.Font.Name := 'Arial';
  InstallVersionLabel.Font.Size := 9;
  InstallVersionLabel.Font.Color := $00576D70;

  WizardForm.StatusLabel.Parent := InstallCard;
  WizardForm.StatusLabel.SetBounds(ScaleX(24), ScaleY(98), CardWidth - ScaleX(48), ScaleY(26));
  WizardForm.StatusLabel.Font.Name := 'Arial';
  WizardForm.StatusLabel.Font.Size := 12;
  WizardForm.StatusLabel.Font.Style := [fsBold];
  WizardForm.StatusLabel.Font.Color := $001F2729;
  WizardForm.StatusLabel.AutoSize := False;
  WizardForm.StatusLabel.WordWrap := True;

  WizardForm.FilenameLabel.Parent := InstallCard;
  WizardForm.FilenameLabel.SetBounds(ScaleX(24), ScaleY(134), CardWidth - ScaleX(48), ScaleY(52));
  WizardForm.FilenameLabel.Font.Name := 'Arial';
  WizardForm.FilenameLabel.Font.Size := 9;
  WizardForm.FilenameLabel.Font.Color := $00576D70;
  WizardForm.FilenameLabel.AutoSize := False;
  WizardForm.FilenameLabel.WordWrap := True;

  FailureDetails := TNewMemo.Create(WizardForm);
  FailureDetails.Parent := InstallCard;
  FailureDetails.SetBounds(ScaleX(24), ScaleY(134), CardWidth - ScaleX(48), ScaleY(112));
  FailureDetails.ReadOnly := True;
  FailureDetails.ScrollBars := ssVertical;
  FailureDetails.Color := clWhite;
  FailureDetails.Font.Name := 'Arial';
  FailureDetails.Font.Size := 9;
  FailureDetails.Font.Color := $00576D70;
  FailureDetails.Visible := False;

  WizardForm.ProgressGauge.Visible := False;
  BrandProgressTrack := TPanel.Create(WizardForm);
  BrandProgressTrack.Parent := InstallCard;
  BrandProgressTrack.SetBounds(ScaleX(24), InstallCard.ClientHeight - ScaleY(48),
    CardWidth - ScaleX(48), ScaleY(8));
  BrandProgressTrack.BevelOuter := bvNone;
  BrandProgressTrack.Color := $00E9E7E1;
  BrandProgressFill := TPanel.Create(WizardForm);
  BrandProgressFill.Parent := BrandProgressTrack;
  BrandProgressFill.SetBounds(0, 0, ScaleX(96), BrandProgressTrack.ClientHeight);
  BrandProgressFill.BevelOuter := bvNone;
  BrandProgressFill.Color := $002DC6F4;
  SetBrandProgressActive;

  CardWidth := WizardForm.FinishedPage.ClientWidth - ScaleX(48);
  FinishCard := TPanel.Create(WizardForm);
  FinishCard.Parent := WizardForm.FinishedPage;
  FinishCard.SetBounds(ScaleX(24), ScaleY(20), CardWidth,
    WizardForm.FinishedPage.ClientHeight - ScaleY(40));
  FinishCard.BevelOuter := bvNone;
  FinishCard.Color := $00F7FAFB;
  ApplyRoundedCard(FinishCard);

  FinishBrandLabel := TNewStaticText.Create(WizardForm);
  FinishBrandLabel.Parent := FinishCard;
  FinishBrandLabel.SetBounds(ScaleX(24), ScaleY(24), CardWidth - ScaleX(48), ScaleY(28));
  FinishBrandLabel.Caption := 'NGTManager';
  FinishBrandLabel.Font.Name := 'Arial';
  FinishBrandLabel.Font.Size := 14;
  FinishBrandLabel.Font.Style := [fsBold];
  FinishBrandLabel.Font.Color := $001F2729;

  FinishVersionLabel := TNewStaticText.Create(WizardForm);
  FinishVersionLabel.Parent := FinishCard;
  FinishVersionLabel.SetBounds(ScaleX(24), ScaleY(54), CardWidth - ScaleX(48), ScaleY(18));
  FinishVersionLabel.Caption := 'v{#AppVersion}';
  FinishVersionLabel.Font.Name := 'Arial';
  FinishVersionLabel.Font.Size := 9;
  FinishVersionLabel.Font.Color := $00576D70;

  WizardForm.FinishedHeadingLabel.Parent := FinishCard;
  WizardForm.FinishedHeadingLabel.SetBounds(ScaleX(24), ScaleY(98), CardWidth - ScaleX(48), ScaleY(30));
  WizardForm.FinishedHeadingLabel.Font.Name := 'Arial';
  WizardForm.FinishedHeadingLabel.Font.Size := 12;
  WizardForm.FinishedHeadingLabel.Font.Style := [fsBold];
  WizardForm.FinishedHeadingLabel.Font.Color := $001F2729;
  WizardForm.FinishedLabel.Parent := FinishCard;
  WizardForm.FinishedLabel.SetBounds(ScaleX(24), ScaleY(138), CardWidth - ScaleX(48), ScaleY(52));
  WizardForm.FinishedLabel.Font.Name := 'Arial';
  WizardForm.FinishedLabel.Font.Size := 10;
  WizardForm.FinishedLabel.Font.Color := $00576D70;
  WizardForm.RunList.Parent := FinishCard;
  WizardForm.RunList.SetBounds(ScaleX(24), ScaleY(208), CardWidth - ScaleX(48), ScaleY(44));
end;

function SafeOperationId(const Value: String): Boolean;
var
  I: Integer;
  C: Char;
begin
  Result := (Length(Value) > 0) and (Length(Value) <= 64);
  for I := 1 to Length(Value) do
  begin
    C := Value[I];
    if not (((C >= 'a') and (C <= 'z')) or ((C >= 'A') and (C <= 'Z')) or
      ((C >= '0') and (C <= '9')) or (C = '-')) then
      Result := False;
  end;
end;

procedure InitializeWizard;
var
  UpdateId: String;
begin
  UpdateId := ExpandConstant('{param:NGTUpdateId|}');
  if UpdateId <> '' then
    AttemptId := UpdateId
  else
    AttemptId := Copy(GetSHA256OfString(
      GetDateTimeString('yyyymmddhhnnss', #0, #0) + IntToStr(GetTickCount64) +
      ExpandConstant('{tmp}') +
      ParamStr(0) + IntToStr(Random(2147483647))), 1, 32);
  WizardForm.BorderIcons := [biSystemMenu, biMinimize];
  ApplyDesktopTheme;
end;

function PhaseDescription(const Phase: String): String;
begin
  if Phase = 'environment_check' then Result := UiText('正在检查 Windows 和必要组件', 'Verifica di Windows e dei componenti richiesti', 'Checking Windows and required components')
  else if Phase = 'windows_compatibility_check' then Result := UiText('正在检查 Windows 兼容性', 'Verifica della compatibilità di Windows', 'Checking Windows compatibility')
  else if Phase = 'runtime_state_preflight' then Result := UiText('正在检查上次运行状态', 'Verifica della sessione precedente', 'Checking the previous NGTManager session')
  else if Phase = 'package_source_verification' then Result := UiText('正在校验离线安装包', 'Verifica del pacchetto offline', 'Verifying the offline package')
  else if Phase = 'runtime_dependency_check' then Result := UiText('正在检查运行组件', 'Verifica dei componenti inclusi', 'Checking bundled runtime components')
  else if Phase = 'installation_path_check' then Result := UiText('正在检查安装目录', 'Verifica delle cartelle di installazione', 'Checking the installation folders')
  else if Phase = 'disk_usage_scan' then Result := UiText('正在计算所需空间', 'Calcolo dello spazio necessario', 'Measuring required space')
  else if Phase = 'disk_space_check' then Result := UiText('正在检查磁盘空间', 'Verifica dello spazio su disco', 'Checking required disk space')
  else if Phase = 'operation_lock' then Result := UiText('正在检查现有安装', 'Verifica dell''installazione esistente', 'Checking the existing installation')
  else if Phase = 'recovery' then Result := UiText('正在安全恢复上次操作', 'Ripristino sicuro dell''operazione precedente', 'Recovering the previous operation safely')
  else if Phase = 'deploy_candidate' then Result := UiText('正在部署程序文件', 'Distribuzione dei file del programma', 'Deploying program files')
  else if Phase = 'source_copy_verification' then Result := UiText('正在复核安装包文件', 'Verifica dei file del pacchetto', 'Rechecking package files')
  else if Phase = 'candidate_file_copy' then Result := UiText('正在复制程序文件', 'Copia dei file del programma', 'Copying program files')
  else if Phase = 'candidate_verification' then Result := UiText('正在完成程序文件部署', 'Completamento della distribuzione', 'Finishing program file deployment')
  else if Phase = 'stop_runtime' then Result := UiText('正在安全停止 NGTManager', 'Arresto sicuro di NGTManager', 'Stopping NGTManager safely')
  else if Phase = 'backup_database' then Result := UiText('正在备份并校验业务数据', 'Backup e verifica dei dati', 'Backing up and verifying business data')
  else if Phase = 'recover_legacy_database' then Result := UiText('正在安全恢复原数据库', 'Ripristino sicuro del database precedente', 'Recovering the previous database safely')
  else if Phase = 'initialize_database' then Result := UiText('正在准备数据库', 'Preparazione del database', 'Preparing the database')
  else if Phase = 'database_ready' then Result := UiText('正在启动数据库', 'Avvio del database', 'Starting the database')
  else if Phase = 'database_migration' then Result := UiText('正在更新数据库结构', 'Aggiornamento della struttura dati', 'Updating the database structure')
  else if Phase = 'application_health' then Result := UiText('正在检查 NGTManager 是否可用', 'Verifica dell''avvio di NGTManager', 'Checking that NGTManager starts correctly')
  else if Phase = 'commit_preparation' then Result := UiText('正在检查最终安全状态', 'Verifica dello stato finale', 'Checking the final safe state')
  else if Phase = 'commit_release' then Result := UiText('正在完成安装', 'Completamento dell''installazione', 'Finishing installation')
  else if Phase = 'complete' then Result := UiText('安装已完成', 'Installazione completata', 'Installation completed')
  else if Phase = 'failed' then Result := UiText('安装已停止，正在恢复原状态', 'Installazione interrotta; ripristino in corso', 'Installation stopped; restoring the previous state')
  else if Phase = 'recovery_failed' then Result := UiText('恢复需要处理，数据已保留', 'Il ripristino richiede attenzione; dati conservati', 'Recovery needs attention; data has been preserved')
  else Result := UiText('正在准备 NGTManager', 'Preparazione di NGTManager', 'Preparing NGTManager');
end;

function TakeField(var Value: String): String;
var
  Separator: Integer;
begin
  Separator := Pos('|', Value);
  if Separator = 0 then
  begin
    Result := Value;
    Value := '';
  end
  else
  begin
    Result := Copy(Value, 1, Separator - 1);
    Delete(Value, 1, Separator);
  end;
end;

procedure ManagerOutput(const S: String; const Error, FirstLine: Boolean);
var
  Fields: String;
  MessageOperationId: String;
  Phase: String;
  PhaseElapsed: String;
  TotalElapsed: String;
  CancelPending: String;
  ProcessedFiles: String;
  ProcessedBytes: String;
  TotalFiles: String;
  TotalBytes: String;
  PhaseElapsedSeconds: Integer;
  TotalElapsedSeconds: Integer;
  ProgressValue: Int64;
  ProgressTotal: Int64;
  StatusText: String;
begin
  Log(S);
  if Copy(S, 1, 13) <> 'NGT_PROGRESS|' then
    exit;
  Fields := Copy(S, 14, Length(S));
  MessageOperationId := TakeField(Fields);
  Phase := TakeField(Fields);
  PhaseElapsed := TakeField(Fields);
  TotalElapsed := TakeField(Fields);
  CancelPending := TakeField(Fields);
  ProcessedFiles := TakeField(Fields);
  ProcessedBytes := TakeField(Fields);
  TotalFiles := TakeField(Fields);
  TotalBytes := TakeField(Fields);
  if MessageOperationId <> AttemptId then
    exit;
  CurrentPhase := Phase;
  PhaseElapsedSeconds := StrToIntDef(PhaseElapsed, 0);
  TotalElapsedSeconds := StrToIntDef(TotalElapsed, 0);
  StatusText := PhaseDescription(Phase);
  if (StrToIntDef(ProcessedFiles, -1) >= 0) then
    StatusText := StatusText + UiText('（已处理 ' + ProcessedFiles + ' 个文件）',
      ' (' + ProcessedFiles + ' file elaborati)',
      ' (' + ProcessedFiles + ' files processed)');
  if PhaseElapsedSeconds > 30 then
    StatusText := StatusText + UiText(' — 此步骤所需时间比平时更长',
      ' — questa fase sta richiedendo più tempo del previsto',
      ' — this step is taking longer than usual');
  if (CancelPending = '1') then
    StatusText := StatusText + UiText('。取消操作将在当前安全步骤结束后执行',
      '. L''annullamento attenderà il prossimo punto sicuro',
      '. Cancellation will wait for the current safe step');
  if (CancelPending = '2') then
    StatusText := StatusText + UiText('。当前阶段已无法取消，正在安全完成',
      '. È troppo tardi per annullare; completamento sicuro in corso',
      '. Cancellation arrived too late; finishing safely');
  WizardForm.StatusLabel.Caption := StatusText;
  WizardForm.FilenameLabel.Caption := UiText(
    '总耗时：' + IntToStr(TotalElapsedSeconds div 60) + '分 ' +
      IntToStr(TotalElapsedSeconds mod 60) + '秒  ·  当前步骤：' +
      IntToStr(PhaseElapsedSeconds) + '秒  ·  操作编号 ' + AttemptId,
    'Tempo totale: ' + IntToStr(TotalElapsedSeconds div 60) + 'm ' +
      IntToStr(TotalElapsedSeconds mod 60) + 's  ·  Fase corrente: ' +
      IntToStr(PhaseElapsedSeconds) + 's  ·  Tentativo ' + AttemptId,
    'Total elapsed: ' + IntToStr(TotalElapsedSeconds div 60) + 'm ' +
      IntToStr(TotalElapsedSeconds mod 60) + 's  ·  Current step: ' +
      IntToStr(PhaseElapsedSeconds) + 's  ·  Attempt ' + AttemptId);
  ProgressValue := StrToInt64Def(ProcessedBytes, -1);
  ProgressTotal := StrToInt64Def(TotalBytes, -1);
  if (ProgressValue < 0) or (ProgressTotal <= 0) then
  begin
    ProgressValue := StrToInt64Def(ProcessedFiles, -1);
    ProgressTotal := StrToInt64Def(TotalFiles, -1);
  end;
  if (ProgressValue >= 0) and (ProgressTotal > 0) then
    SetBrandProgress(ProgressValue, ProgressTotal)
  else
    SetBrandProgressActive;
end;

procedure PollManagerProgress;
var
  ProgressLine: AnsiString;
begin
  if (ProgressPath = '') or (not FileExists(ProgressPath)) then exit;
  if not LoadStringFromFile(ProgressPath, ProgressLine) then exit;
  ProgressLine := Trim(ProgressLine);
  if (ProgressLine = '') or (ProgressLine = LastProgressLine) then exit;
  LastProgressLine := ProgressLine;
  ManagerOutput(ProgressLine, False, False);
end;

function ReadManagerError: String;
var
  ResultSize: Integer;
  I: Integer;
  ResultLines: TArrayOfString;
begin
  Result := '';
  if not FileSize(ResultPath, ResultSize) then exit;
  if (ResultSize < 0) or (ResultSize > 4096) then exit;
  if not LoadStringsFromFile(ResultPath, ResultLines) then exit;
  if GetArrayLength(ResultLines) < 2 then exit;
  if ResultLines[0] <> 'ERROR' then exit;
  Result := Copy(ResultLines[1], 1, 1024);
  for I := 2 to GetArrayLength(ResultLines) - 1 do
    Result := Copy(Result + #13#10 + ResultLines[I], 1, 2048);
end;

function ManagerResultSucceeded: Boolean;
var
  ResultSize: Integer;
  ResultLines: TArrayOfString;
begin
  Result := False;
  if not FileSize(ResultPath, ResultSize) then exit;
  if (ResultSize < 0) or (ResultSize > 4096) then exit;
  if not LoadStringsFromFile(ResultPath, ResultLines) then exit;
  Result := (GetArrayLength(ResultLines) >= 1) and (ResultLines[0] = 'SUCCESS');
end;

function ExportFailureDiagnostics(ManagerPath: String): String;
var
  DiagnosticPath: String;
  ResultCode: Integer;
  Started: Boolean;
begin
  Result := '';
  DiagnosticPath := ExpandConstant('{userdocs}\NGTManager-diagnostics-' + AttemptId + '.txt');
  if FileExists(DiagnosticPath) or (not FileExists(ManagerPath)) then exit;
  Started := Exec(ManagerPath, 'diagnose-export "' + DiagnosticPath + '"',
    ExtractFileDir(ManagerPath), SW_HIDE, ewWaitUntilTerminated, ResultCode);
  if Started and (ResultCode = 0) and FileExists(DiagnosticPath) then
    Result := DiagnosticPath;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo,
  MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := 'Install location:' + NewLine + Space + ExpandConstant('{localappdata}\NGTManager');
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  FreeBytes: Int64;
  TotalBytes: Int64;
  Required: Int64;
  TempPath: String;
begin
  NeedsRestart := False;
  Result := '';
  AttemptStartTick := GetTickCount64;
  if not SafeOperationId(AttemptId) then
  begin
    Result := 'The installer operation ID is invalid.';
    exit;
  end;
  TempPath := ExpandConstant('{tmp}');
  Required := {#PackageBytes} + 134217728;
  if not GetSpaceOnDisk64(TempPath, FreeBytes, TotalBytes) then
    Result := 'Unable to check temporary disk space at ' + TempPath
  else if FreeBytes < Required then
    Result := 'Insufficient temporary disk space at ' + TempPath + '. Available: ' +
      IntToStr(FreeBytes) + ' bytes. Additional space required: ' + IntToStr(Required - FreeBytes) + ' bytes.';
  Log('NGTManager install attempt ID: ' + AttemptId);
end;

function ManagerParameters(Param: String): String;
var
  PackagePath: String;
  Operation: String;
  UpdateId: String;
  ExtractionElapsedMs: Int64;
begin
  UpdateId := ExpandConstant('{param:NGTUpdateId|}');
  PackagePath := ExpandConstant('{tmp}\ngt-package');
  Operation := 'install';
  if UpdateId <> '' then Operation := 'update';
  ExtractionElapsedMs := GetTickCount64 - AttemptStartTick;
  Result := Operation + ' "' + PackagePath + '" ' + AttemptId +
    ' --result-file "' + ExpandConstant('{tmp}\NGTManager-setup-result-' + AttemptId + '.txt') +
    '" --cancel-file "' + ExpandConstant('{tmp}\NGTManager-' + AttemptId + '.cancel') +
    '" --progress-file "' + ExpandConstant('{tmp}\NGTManager-setup-progress-' + AttemptId + '.txt') +
    '" --process-id-file "' + ExpandConstant('{tmp}\NGTManager-setup-process-' + AttemptId + '.pid') +
    '" --package-extract-ms ' + IntToStr(ExtractionElapsedMs) +
    ' --package-file-count {#PackageFileCount}';
end;

procedure PrepareManagerRun;
begin
  ResultPath := ExpandConstant('{tmp}\NGTManager-setup-result-' + AttemptId + '.txt');
  CancelPath := ExpandConstant('{tmp}\NGTManager-' + AttemptId + '.cancel');
  ProgressPath := ExpandConstant('{tmp}\NGTManager-setup-progress-' + AttemptId + '.txt');
  ProcessIdPath := ExpandConstant('{tmp}\NGTManager-setup-process-' + AttemptId + '.pid');
  DeleteFile(ResultPath);
  DeleteFile(CancelPath);
  DeleteFile(ProgressPath);
  DeleteFile(ProcessIdPath);
  SetBrandProgressActive;
  Log('NGTManager package extraction completed; files={#PackageFileCount}');
  CoreRunning := True;
  CancelRequested := False;
  CurrentPhase := 'environment_check';
  WizardForm.StatusLabel.Caption := PhaseDescription(CurrentPhase);
  WizardForm.FilenameLabel.Caption := UiText('操作编号 ', 'Tentativo ', 'Attempt ') + AttemptId;
  Log('NGTManager transaction started.');
  LastProgressLine := '';
end;

procedure ProcessWizardMessages; forward;

procedure FinishManagerRun;
var
  ManagerPath: String;
  ManagerError: String;
  MessageText: String;
  DiagnosticPath: String;
  Failure: String;
begin
  PollManagerProgress;
  CoreRunning := False;
  SetBrandProgress(1, 1);
  Failure := '';
  ManagerPath := ExpandConstant('{tmp}\ngt-package\tools\NGTManager.exe');
  if ManagerResultSucceeded then
  begin
    PrepareSucceeded := True;
    CoreCommitted := True;
    WizardForm.CancelButton.Enabled := False;
    Log('NGTManager core committed; continuing Setup registration.');
    if not DeleteFile(ExpandConstant('{autodesktop}\NGT 工作室管理系统.url')) then
      Log('Legacy desktop URL cleanup was skipped.');
    if not DeleteFile(ExpandConstant('{autoprograms}\NGT 工作室管理系统.url')) then
      Log('Legacy Start Menu URL cleanup was skipped.');
    exit;
  end;

  ManagerError := ReadManagerError;
  if ManagerError <> '' then
    MessageText := ManagerError
  else if CancelRequested then
    MessageText := 'Cancellation was requested. Setup waited for a safe rollback point.'
  else
    MessageText := 'NGTManager stopped during: ' + PhaseDescription(CurrentPhase) + '.';
  DiagnosticPath := ExportFailureDiagnostics(ManagerPath);
  if DiagnosticPath <> '' then
    MessageText := MessageText + #13#10 + 'Unified diagnostics saved to: ' + DiagnosticPath
  else
    MessageText := MessageText + #13#10 + 'Open the matching Inno Setup Log in %TEMP% for installation details.';
  Failure := MessageText + #13#10 + 'Attempt ID: ' + AttemptId + #13#10 +
    'After NGTManager starts, use Settings > Export diagnostics to create one support file.';
  Log('NGTManager core failed or did not produce a success result; attempt=' + AttemptId + '.');
  PrepareSucceeded := False;
  if not PrepareSucceeded then
  begin
    BrandProgressFill.Color := $005252D9;
    WizardForm.StatusLabel.Caption := UiText(
      '安装未完成，数据已保留',
      'Installazione non completata; dati conservati',
      'Installation did not complete; data was preserved');
    WizardForm.FilenameLabel.Visible := False;
    FailureDetails.Text := MessageText + #13#10 +
      UiText('操作编号：', 'Tentativo: ', 'Attempt ID: ') + AttemptId;
    FailureDetails.Visible := True;
    ProcessWizardMessages;
    if WizardSilent then
      RaiseException(Failure)
    else
    begin
      MsgBox(Failure, mbCriticalError, MB_OK);
      CancelWithoutPrompt := True;
      WizardForm.Close;
    end;
  end;
end;

procedure ProcessWizardMessages;
var
  Msg: TWindowsMessage;
begin
  AnimateBrandProgress;
  while PeekMessage(Msg, 0, 0, 0, 1) do
  begin
    TranslateMessage(Msg);
    DispatchMessage(Msg);
  end;
end;

procedure CurInstallProgressChanged(CurProgress, MaxProgress: Integer);
begin
  if not CoreRunning then
    SetBrandProgress(CurProgress, MaxProgress);
  ProcessWizardMessages;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  WizardForm.MainPanel.Visible :=
    (CurPageID <> wpInstalling) and (CurPageID <> wpFinished);
  if CurPageID = wpFinished then
  begin
    WizardForm.FinishedHeadingLabel.Caption := UiText(
      'NGTManager 已准备就绪',
      'NGTManager è pronto',
      'NGTManager is ready');
    WizardForm.FinishedLabel.Caption := UiText(
      '可通过桌面快捷方式打开 NGTManager；关闭业务窗口后，仍可从系统托盘重新打开或安全退出。',
      'Apri NGTManager dal collegamento sul desktop. Dopo aver chiuso la finestra, puoi riaprirlo o uscire in sicurezza dall''area di notifica.',
      'Open NGTManager from the desktop shortcut. After closing the application window, use the tray icon to reopen it or exit safely.');
  end;
end;

procedure InstallExtractedPackage;
var
  ManagerPath: String;
  ProcessIdText: AnsiString;
  ProcessId: Integer;
  ProcessHandle: THandle;
  ResultCode: Integer;
  Started: Boolean;
  WaitResult: DWORD;
  PidDeadline: Int64;
begin
  PrepareManagerRun;
  ManagerPath := ExpandConstant('{tmp}\ngt-package\tools\NGTManager.exe');
  ResultCode := -1;
  Started := Exec(ManagerPath, ManagerParameters(''),
    ExtractFileDir(ManagerPath), SW_HIDE, ewNoWait, ResultCode);
  if not Started then
  begin
    Log('Unable to start NGTManager core: ' + SysErrorMessage(ResultCode));
    FinishManagerRun;
    exit;
  end;

  PidDeadline := GetTickCount64 + 10000;
  while (not FileExists(ProcessIdPath)) and (GetTickCount64 < PidDeadline) do
  begin
    ProcessWizardMessages;
    PollManagerProgress;
    Sleep(50);
  end;
  if (not LoadStringFromFile(ProcessIdPath, ProcessIdText)) then
  begin
    Log('NGTManager core did not publish its process ID.');
    FinishManagerRun;
    exit;
  end;
  ProcessId := StrToIntDef(Trim(ProcessIdText), 0);
  ProcessHandle := OpenProcess($00101000, False, ProcessId);
  if ProcessHandle = 0 then
  begin
    Log('Unable to open the NGTManager core process handle.');
    FinishManagerRun;
    exit;
  end;

  repeat
    WaitResult := WaitForSingleObject(ProcessHandle, 100);
    ProcessWizardMessages;
    PollManagerProgress;
  until WaitResult <> $00000102;
  CloseHandle(ProcessHandle);
  if WaitResult <> 0 then
    Log('Waiting for the NGTManager core failed with code ' + IntToStr(WaitResult) + '.');
  FinishManagerRun;
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if CancelWithoutPrompt then
  begin
    Confirm := False;
    exit;
  end;
  if CoreRunning then
  begin
    Cancel := False;
    Confirm := False;
    if not CancelRequested then
    begin
      CancelRequested := True;
      if SaveStringToFile(CancelPath, 'cancel', False) then
      begin
        WizardForm.StatusLabel.Caption := UiText(
          '正在等待安全停止点',
          'Attesa del punto di arresto sicuro',
          'Waiting for a safe stopping point');
        WizardForm.FilenameLabel.Caption := UiText(
          'NGTManager 将在当前安全步骤结束后回滚，请保持此窗口打开。',
          'NGTManager completerà la fase sicura corrente prima del ripristino. Tieni aperta questa finestra.',
          'NGTManager will finish the current safe step before rolling back. Keep this window open.');
        WizardForm.CancelButton.Enabled := False;
        Log('User requested cancellation; deferring to the next safe transaction checkpoint.');
      end
      else
      begin
        CancelRequested := False;
        Log('Unable to write the cancellation request marker.');
        WizardForm.StatusLabel.Caption := UiText(
          '无法提交取消请求',
          'Impossibile richiedere l''annullamento',
          'Unable to request cancellation');
        WizardForm.FilenameLabel.Caption := UiText(
          '操作仍在运行，请保持此窗口打开。',
          'L''operazione è ancora in corso. Tieni aperta questa finestra.',
          'The operation is still running. Keep this window open.');
      end;
    end;
  end
  else if CoreCommitted then
  begin
    Cancel := False;
    Confirm := False;
    Log('Cancellation ignored because the NGTManager core has already committed.');
  end;
end;

function ReportInstallerRegistration(const Outcome: String): Boolean;
var
  ManagerPath: String;
  InstallRoot: String;
  Parameters: String;
  ResultCode: Integer;
  Started: Boolean;
  ElapsedMs: Int64;
begin
  InstallRoot := ExpandConstant('{localappdata}\NGTManager');
  ManagerPath := InstallRoot + '\tools\NGTManager.exe';
  ElapsedMs := GetTickCount64 - AttemptStartTick;
  Parameters := 'record-installer-registration ' + AttemptId + ' ' +
    IntToStr(ElapsedMs) + ' ' + Outcome;
  ResultCode := -1;
  Started := ExecAndLogOutput(ManagerPath, Parameters, InstallRoot,
    SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode, nil);
  Result := Started and (ResultCode = 0);
  if Result then
    Log('NGTManager Inno registration result recorded; outcome=' + Outcome +
      '; elapsedMs=' + IntToStr(ElapsedMs) + '.')
  else
    Log('NGTManager Inno registration result could not be recorded; outcome=' + Outcome +
      '; exit=' + IntToStr(ResultCode) + '.');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and PrepareSucceeded then
  begin
    if not ReportInstallerRegistration('complete') then
      RaiseException('NGTManager was committed, but setup registration could not be confirmed. Run this same installer to finish registration.');
    PostInstallReached := True;
  end;
end;

procedure DeinitializeSetup;
begin
  if PrepareSucceeded and not PostInstallReached then
    ReportInstallerRegistration('incomplete');
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
