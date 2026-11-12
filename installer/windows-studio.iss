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

[Files]
Source: "{#PackageDirectory}\*"; DestDir: "{tmp}\ngt-package"; Excludes: "\studio-release.json"; Flags: deleteafterinstall ignoreversion recursesubdirs createallsubdirs
Source: "{#PackageDirectory}\studio-release.json"; DestDir: "{tmp}\ngt-package"; Flags: deleteafterinstall ignoreversion; AfterInstall: InstallExtractedPackage

[Icons]
Name: "{autodesktop}\{#AppName}"; Filename: "{localappdata}\NGTManager\tools\NGTManager.exe"; Parameters: "open"; WorkingDir: "{localappdata}\NGTManager"; IconFilename: "{localappdata}\NGTManager\assets\ngt-studio.ico"
Name: "{autoprograms}\{#AppName}"; Filename: "{localappdata}\NGTManager\tools\NGTManager.exe"; Parameters: "open"; WorkingDir: "{localappdata}\NGTManager"; IconFilename: "{localappdata}\NGTManager\assets\ngt-studio.ico"

[Run]
Filename: "{localappdata}\NGTManager\tools\NGTManager.exe"; Parameters: "open"; Description: "Open {#AppName}"; Flags: runhidden postinstall nowait skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\NGTManager\releases"
Type: filesandordirs; Name: "{localappdata}\NGTManager\tools"
Type: filesandordirs; Name: "{localappdata}\NGTManager\assets"

[Code]
var
  AttemptId: String;
  ResultPath: String;
  CancelPath: String;
  ProgressPath: String;
  LastProgressLine: String;
  ProgressTimerId: UINT_PTR;
  CurrentPhase: String;
  CoreRunning: Boolean;
  CoreCommitted: Boolean;
  CancelRequested: Boolean;
  PrepareSucceeded: Boolean;
  AttemptStartTick: Int64;
  PostInstallReached: Boolean;
  CancelWithoutPrompt: Boolean;

function GetTickCount64: Int64;
  external 'GetTickCount64@kernel32.dll stdcall';

function SetTimer(hWnd: HWND; nIDEvent: UINT_PTR; uElapse: UINT;
  lpTimerFunc: LongWord): UINT_PTR;
  external 'SetTimer@user32.dll stdcall';

function KillTimer(hWnd: HWND; uIDEvent: UINT_PTR): BOOL;
  external 'KillTimer@user32.dll stdcall';

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
end;

function PhaseDescription(const Phase: String): String;
begin
  if Phase = 'environment_check' then Result := 'Checking Windows and required components'
  else if Phase = 'windows_compatibility_check' then Result := 'Checking Windows 10 compatibility'
  else if Phase = 'package_source_verification' then Result := 'Verifying the offline package'
  else if Phase = 'runtime_dependency_check' then Result := 'Checking bundled runtime components'
  else if Phase = 'installation_path_check' then Result := 'Checking access to the installation folders'
  else if Phase = 'disk_usage_scan' then Result := 'Measuring package and existing data'
  else if Phase = 'disk_space_check' then Result := 'Checking required disk space'
  else if Phase = 'operation_lock' then Result := 'Checking the existing installation'
  else if Phase = 'recovery' then Result := 'Recovering or safely stopping an earlier operation'
  else if Phase = 'deploy_candidate' then Result := 'Verifying and copying program files'
  else if Phase = 'source_copy_verification' then Result := 'Rechecking package files before copying'
  else if Phase = 'candidate_file_copy' then Result := 'Copying program files'
  else if Phase = 'candidate_verification' then Result := 'Verifying copied program files'
  else if Phase = 'stop_runtime' then Result := 'Waiting for NGTManager to stop safely'
  else if Phase = 'backup_database' then Result := 'Backing up and verifying business data'
  else if Phase = 'recover_legacy_database' then Result := 'Recovering the previous database safely'
  else if Phase = 'initialize_database' then Result := 'Preparing the first database'
  else if Phase = 'database_ready' then Result := 'Starting the database'
  else if Phase = 'database_migration' then Result := 'Updating the database structure'
  else if Phase = 'application_health' then Result := 'Checking that NGTManager starts correctly'
  else if Phase = 'commit_preparation' then Result := 'Checking the final safe cancellation point'
  else if Phase = 'commit_release' then Result := 'Finishing installation'
  else if Phase = 'complete' then Result := 'Installation completed'
  else if Phase = 'failed' then Result := 'Installation stopped; restoring the previous state'
  else if Phase = 'recovery_failed' then Result := 'Recovery needs attention; data has been preserved'
  else Result := 'Preparing NGTManager';
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
  PhaseElapsedSeconds: Integer;
  TotalElapsedSeconds: Integer;
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
  if MessageOperationId <> AttemptId then
    exit;
  CurrentPhase := Phase;
  PhaseElapsedSeconds := StrToIntDef(PhaseElapsed, 0);
  TotalElapsedSeconds := StrToIntDef(TotalElapsed, 0);
  StatusText := PhaseDescription(Phase);
  if (StrToIntDef(ProcessedFiles, -1) >= 0) then
    StatusText := StatusText + ' (' + ProcessedFiles + ' files processed)';
  if PhaseElapsedSeconds > 30 then
    StatusText := StatusText + ' — this step is taking longer than usual';
  if (CancelPending = '1') then
    StatusText := StatusText + '. Cancellation will wait for the current safe step';
  if (CancelPending = '2') then
    StatusText := StatusText + '. Cancellation arrived too late; finishing safely';
  WizardForm.StatusLabel.Caption := StatusText;
  WizardForm.FilenameLabel.Caption :=
    'Total elapsed: ' + IntToStr(TotalElapsedSeconds div 60) + 'm ' +
    IntToStr(TotalElapsedSeconds mod 60) + 's  ·  Current step: ' +
    IntToStr(PhaseElapsedSeconds) + 's  ·  Attempt ' + AttemptId;
end;

procedure PollManagerProgress(Arg1: HWND; Arg2: UINT; Arg3: UINT_PTR; Arg4: DWORD);
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

procedure InstallExtractedPackage;
var
  ManagerPath: String;
  PackagePath: String;
  Operation: String;
  Parameters: String;
  UpdateId: String;
  Started: Boolean;
  ResultCode: Integer;
  ExtractionElapsedMs: Int64;
  ManagerError: String;
  MessageText: String;
  DiagnosticPath: String;
  Failure: String;
begin
  Failure := '';
  UpdateId := ExpandConstant('{param:NGTUpdateId|}');
  PackagePath := ExpandConstant('{tmp}\ngt-package');
  ManagerPath := PackagePath + '\tools\NGTManager.exe';
  ResultPath := ExpandConstant('{tmp}\NGTManager-setup-result-' + AttemptId + '.txt');
  CancelPath := ExpandConstant('{tmp}\NGTManager-' + AttemptId + '.cancel');
  ProgressPath := ExpandConstant('{tmp}\NGTManager-setup-progress-' + AttemptId + '.txt');
  DeleteFile(ResultPath);
  DeleteFile(CancelPath);
  DeleteFile(ProgressPath);
  WizardForm.ProgressGauge.Style := npbstMarquee;
  try
    try
      ExtractionElapsedMs := GetTickCount64 - AttemptStartTick;
      Log('NGTManager package extraction completed; files={#PackageFileCount}');
      if not FileExists(ManagerPath) then
      begin
        Failure := 'The offline package is incomplete. Attempt ID: ' + AttemptId +
          '. Open the Inno Setup Log in %TEMP% and retry with the complete installer.';
      end
      else
      begin
        Operation := 'install';
        if UpdateId <> '' then Operation := 'update';
        Parameters := Operation + ' "' + PackagePath + '" ' + AttemptId +
          ' --result-file "' + ResultPath + '" --cancel-file "' + CancelPath +
          '" --progress-file "' + ProgressPath +
          '" --package-extract-ms ' + IntToStr(ExtractionElapsedMs) +
          ' --package-file-count {#PackageFileCount}';
        CoreRunning := True;
        CancelRequested := False;
        CurrentPhase := 'environment_check';
        WizardForm.StatusLabel.Caption := PhaseDescription(CurrentPhase);
        WizardForm.FilenameLabel.Caption := 'Attempt ' + AttemptId;
        Log('NGTManager transaction started; operation=' + Operation + '.');
        LastProgressLine := '';
        ProgressTimerId := SetTimer(0, 0, 250, CreateCallback(@PollManagerProgress));
        try
          Started := Exec(ManagerPath, Parameters, PackagePath,
            SW_HIDE, ewWaitUntilTerminated, ResultCode);
        finally
          if ProgressTimerId <> 0 then KillTimer(0, ProgressTimerId);
          ProgressTimerId := 0;
          PollManagerProgress(0, 0, 0, 0);
        end;
        CoreRunning := False;
        if (not Started) or (ResultCode <> 0) then
        begin
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
          Log('NGTManager core failed or cancellation was requested; exit=' + IntToStr(ResultCode) +
            '; attempt=' + AttemptId + '.');
        end
        else
        begin
          CoreCommitted := True;
          WizardForm.CancelButton.Enabled := False;
          WizardForm.Update;
          Log('NGTManager core committed; continuing Setup registration.');
          if not DeleteFile(ExpandConstant('{autodesktop}\NGT 工作室管理系统.url')) then
            Log('Legacy desktop URL cleanup was skipped.');
          if not DeleteFile(ExpandConstant('{autoprograms}\NGT 工作室管理系统.url')) then
            Log('Legacy Start Menu URL cleanup was skipped.');
        end;
      end;
    except
      Log('NGTManager preparation raised an exception; attempt=' + AttemptId + '.');
      Failure := 'NGTManager could not finish package preparation. Attempt ID: ' + AttemptId + #13#10 +
        'Open the matching Inno Setup Log in %TEMP% and retry with the complete offline installer.';
    end;
  finally
    CoreRunning := False;
    WizardForm.ProgressGauge.Style := npbstNormal;
  end;
  PrepareSucceeded := Failure = '';
  if not PrepareSucceeded then
  begin
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
        WizardForm.StatusLabel.Caption := 'Cancellation requested';
        WizardForm.FilenameLabel.Caption := 'NGTManager will finish the current safe step before rolling back.';
        Log('User requested cancellation; deferring to the next safe transaction checkpoint.');
      end
      else
      begin
        CancelRequested := False;
        Log('Unable to write the cancellation request marker.');
        WizardForm.StatusLabel.Caption := 'Unable to request cancellation';
        WizardForm.FilenameLabel.Caption := 'The operation is still running. Keep this window open.';
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
