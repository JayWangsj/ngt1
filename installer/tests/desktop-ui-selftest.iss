{ Compiled only with /DDesktopUiTest; exits before any installation transaction. }
procedure FinishUiTest(Code: Integer);
  external 'ExitProcess@kernel32.dll stdcall';

procedure CheckUi(Condition: Boolean; const Message: String);
begin
  if not Condition then RaiseException(Message);
end;

procedure RunDesktopUiSelfTests;
var
  Tick: Int64;
  Phases: TArrayOfString;
  I: Integer;
  Output: String;
begin
  Output := ExpandConstant('{param:UiTestResult|}');
  try
    CheckUi(InstallRail.Parent = WizardForm, 'Brand rail must extend through the footer');
    CheckUi(InstallRail.Height = WizardForm.ClientHeight, 'Brand rail height');
    CheckUi(WizardForm.Bevel.Left = ScaleX(180), 'Footer separator crosses the rail');
    CheckUi(WizardForm.RunList.Parent = FinishInfo, 'Open option parent');
    CheckUi(WizardForm.RunList.Color = FinishInfo.Color, 'Open option background');
    SetArrayLength(Phases, 8);
    Phases[0] := 'package_extraction';
    Phases[1] := 'package_source_verification';
    Phases[2] := 'candidate_file_copy';
    Phases[3] := 'candidate_verification';
    Phases[4] := 'database_migration';
    Phases[5] := 'application_health';
    Phases[6] := 'recovery';
    Phases[7] := 'rollback';
    for I := 0 to GetArrayLength(Phases) - 1 do
    begin
      ManagerOutput('NGT_PROGRESS|' + AttemptId + '|' + Phases[I] + '|1|1|0|1|10||', False, False);
      CheckUi(not BrandProgressDeterminate, 'Missing totals must use activity mode');
      BrandProgressAnimationTick := GetTickCount64 - 2000;
      Tick := BrandProgressAnimationTick;
      ManagerOutput('NGT_PROGRESS|' + AttemptId + '|' + Phases[I] + '|2|2|0|2|20||', False, False);
      CheckUi(Tick = BrandProgressAnimationTick, 'Heartbeat restarted activity animation');
      AnimateBrandProgress;
      CheckUi(BrandProgressFill.Width > 0, 'Activity segment missing');
      ManagerOutput('NGT_PROGRESS|' + AttemptId + '|' + Phases[I] + '|3|3|0|4|40|10|100', False, False);
      CheckUi(BrandProgressDeterminate and (BrandProgressPosition = 400), 'Determinate byte progress');
      ManagerOutput('NGT_PROGRESS|' + AttemptId + '|' + Phases[I] + '|4|4|0|3|30|10|100', False, False);
      CheckUi(BrandProgressPosition = 400, 'Progress moved backwards within a phase');
      ManagerOutput('NGT_PROGRESS|' + AttemptId + '|' + Phases[I] + '|5|5|1|10|100|10|100', False, False);
      CheckUi(BrandProgressPosition = 1000, 'Stage completion did not reach the end');
      CheckUi(InstallWarningLabel.Visible, 'Cancel safety notice missing');
      ManagerOutput('NGT_PROGRESS|' + AttemptId + '|test_transition|0|5|0|0|0|10|100', False, False);
      CheckUi(BrandProgressPosition = 0, 'New phase did not reset its own progress');
    end;
    SaveStringToFile(Output, 'PASS: native Inno progress, heartbeat continuity, stage reset, rail and finish option', False);
    FinishUiTest(0);
  except
    SaveStringToFile(Output, 'FAIL: ' + GetExceptionMessage, False);
    FinishUiTest(1);
  end;
end;
