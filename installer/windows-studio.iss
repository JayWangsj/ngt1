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
Source: "{#PackageDirectory}\*"; DestDir: "{app}"; Flags: dontcopy ignoreversion recursesubdirs createallsubdirs

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
  ProgressPage: TOutputMarqueeProgressWizardPage;
  AttemptId: String;
  ResultPath: String;
  CancelPath: String;
  CurrentPhase: String;
  CoreRunning: Boolean;
  CoreCommitted: Boolean;
  CancelRequested: Boolean;
  PrepareSucceeded: Boolean;
  AttemptStartTick: Int64;
  PostInstallReached: Boolean;

function GetTickCount64: Int64;
  external 'GetTickCount64@kernel32.dll stdcall';

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
  ProgressPage := CreateOutputMarqueeProgressPage(
    'Installing NGTManager',
    'The full offline package is being prepared. The installation remains active while this step runs.');
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
  if MessageOperationId <> AttemptId then
    exit;
  CurrentPhase := Phase;
  PhaseElapsedSeconds := StrToIntDef(PhaseElapsed, 0);
  TotalElapsedSeconds := StrToIntDef(TotalElapsed, 0);
  StatusText := PhaseDescription(Phase);
  if PhaseElapsedSeconds > 30 then
    StatusText := StatusText + ' — this step is taking longer than usual';
  if (CancelPending = '1') then
    StatusText := StatusText + '. Cancellation will wait for the current safe step';
  if (CancelPending = '2') then
    StatusText := StatusText + '. Cancellation arrived too late; finishing safely';
  ProgressPage.SetText(StatusText,
    'Total elapsed: ' + IntToStr(TotalElapsedSeconds div 60) + 'm ' +
    IntToStr(TotalElapsedSeconds mod 60) + 's  ·  Current step: ' +
    IntToStr(PhaseElapsedSeconds) + 's  ·  Attempt ' + AttemptId);
  ProgressPage.Animate;
end;

function ReadManagerError: String;
var
  ResultSize: Integer;
  ResultLines: TArrayOfString;
begin
  Result := '';
  if not FileSize(ResultPath, ResultSize) then exit;
  if (ResultSize < 0) or (ResultSize > 4096) then exit;
  if not LoadStringsFromFile(ResultPath, ResultLines) then exit;
  if GetArrayLength(ResultLines) < 2 then exit;
  if ResultLines[0] <> 'ERROR' then exit;
  Result := Copy(ResultLines[1], 1, 512);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ManagerPath: String;
  PackagePath: String;
  Operation: String;
  Parameters: String;
  UpdateId: String;
  Started: Boolean;
  ResultCode: Integer;
  ExtractedFiles: Integer;
  ExtractStartedTick: Int64;
  ExtractionElapsedMs: Int64;
  ManagerError: String;
  MessageText: String;
begin
  NeedsRestart := False;
  if PrepareSucceeded then
  begin
    Result := '';
    exit;
  end;

  WizardForm.CancelButton.Enabled := True;
  WizardForm.Update;
  CancelRequested := False;
  Result := '';
  AttemptStartTick := GetTickCount64;
  UpdateId := ExpandConstant('{param:NGTUpdateId|}');
  if not SafeOperationId(AttemptId) then
  begin
    Result := 'The installer operation ID is invalid. Setup Log: see the Inno Setup Log in %TEMP%.';
    PrepareSucceeded := False;
    exit;
  end;
  PackagePath := ExpandConstant('{tmp}\') + '{app}';
  ManagerPath := PackagePath + '\tools\NGTManager.exe';
  ResultPath := ExpandConstant('{tmp}\NGTManager-setup-result-' + AttemptId + '.txt');
  CancelPath := ExpandConstant('{tmp}\NGTManager-' + AttemptId + '.cancel');
  DeleteFile(ResultPath);
  DeleteFile(CancelPath);
  ProgressPage.SetText('Unpacking the offline installation package',
    'This preparation step may take a short time. The progress bar is indeterminate.');
  ProgressPage.Show;
  ProgressPage.Animate;
  try
    try
      Log('NGTManager install attempt ID: ' + AttemptId);
      Log('NGTManager package extraction started.');
      ExtractStartedTick := GetTickCount64;
      ExtractedFiles := ExtractTemporaryFiles('{app}\*');
      ExtractionElapsedMs := GetTickCount64 - ExtractStartedTick;
      Log('NGTManager package extraction completed; files=' + IntToStr(ExtractedFiles));
      if not FileExists(ManagerPath) then
      begin
        Result := 'The offline package is incomplete. Attempt ID: ' + AttemptId +
          '. Open the Inno Setup Log in %TEMP% and retry with the complete installer.';
      end
      else
      begin
        Operation := 'install';
        if UpdateId <> '' then Operation := 'update';
        Parameters := Operation + ' "' + PackagePath + '" ' + AttemptId +
          ' --result-file "' + ResultPath + '" --cancel-file "' + CancelPath +
          '" --package-extract-ms ' + IntToStr(ExtractionElapsedMs) +
          ' --package-file-count ' + IntToStr(ExtractedFiles);
        CoreRunning := True;
        CancelRequested := False;
        CurrentPhase := 'environment_check';
        ProgressPage.SetText(PhaseDescription(CurrentPhase),
          'Elapsed: 0s  ·  Attempt ' + AttemptId);
        Log('NGTManager transaction started; operation=' + Operation + '.');
        Started := ExecAndLogOutput(ManagerPath, Parameters, PackagePath,
          SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode, @ManagerOutput);
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
          Result := MessageText + #13#10 + 'Attempt ID: ' + AttemptId + #13#10 +
            'Open the matching Inno Setup Log in %TEMP% for installation details.' + #13#10 +
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
      Result := 'NGTManager could not finish package preparation. Attempt ID: ' + AttemptId + #13#10 +
        'Open the matching Inno Setup Log in %TEMP% and retry with the complete offline installer.';
    end;
  finally
    CoreRunning := False;
    ProgressPage.Hide;
  end;
  PrepareSucceeded := Result = '';
end;

procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if CoreRunning then
  begin
    Cancel := False;
    Confirm := False;
    if not CancelRequested then
    begin
      CancelRequested := True;
      if SaveStringToFile(CancelPath, 'cancel', False) then
      begin
        ProgressPage.SetText('Cancellation requested',
          'NGTManager will finish the current safe step before rolling back.');
        Log('User requested cancellation; deferring to the next safe transaction checkpoint.');
      end
      else
      begin
        CancelRequested := False;
        Log('Unable to write the cancellation request marker.');
        ProgressPage.SetText('Unable to request cancellation',
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

procedure ReportInstallerRegistration(const Outcome: String);
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
  if Started and (ResultCode = 0) then
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
    PostInstallReached := True;
    ReportInstallerRegistration('complete');
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
