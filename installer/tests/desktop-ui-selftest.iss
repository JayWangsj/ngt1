{ Compiled only with /DDesktopUiTest; exits before any installation transaction. }
procedure FinishUiTest(Code: Integer);
  external 'ExitProcess@kernel32.dll stdcall';

procedure CheckUi(Condition: Boolean; const Message: String);
begin
  if not Condition then RaiseException(Message);
end;

function GetWindowRgn(Wnd: HWND; Rgn: THandle): Integer;
  external 'GetWindowRgn@user32.dll stdcall';
function PointInRegion(Rgn: THandle; X, Y: Integer): BOOL;
  external 'PtInRegion@gdi32.dll stdcall';
function UiGetDC(Wnd: HWND): THandle;
  external 'GetDC@user32.dll stdcall';
function UiReleaseDC(Wnd: HWND; DC: THandle): Integer;
  external 'ReleaseDC@user32.dll stdcall';
function UiCreateDC(DC: THandle): THandle;
  external 'CreateCompatibleDC@gdi32.dll stdcall';
function UiCreateBitmap(DC: THandle; W, H: Integer): THandle;
  external 'CreateCompatibleBitmap@gdi32.dll stdcall';
function UiDeleteDC(DC: THandle): BOOL;
  external 'DeleteDC@gdi32.dll stdcall';
function UiGetPixel(DC: THandle; X, Y: Integer): Cardinal;
  external 'GetPixel@gdi32.dll stdcall';

procedure CheckRoundCard(Panel: TPanel);
var
  Rgn: THandle;
begin
  Rgn := CreateRoundRectRgn(0, 0, 1, 1, 0, 0);
  try
    CheckUi(GetWindowRgn(Panel.Handle, Rgn) <> 0, 'Missing card region');
    CheckUi(not PointInRegion(Rgn, 0, 0), 'Left top corner is square');
    CheckUi(not PointInRegion(Rgn, Panel.Width - 1, 0), 'Right top corner is square');
    CheckUi(not PointInRegion(Rgn, Panel.Width - 1, Panel.Height - 1), 'Right bottom corner is square');
    CheckUi(PointInRegion(Rgn, Panel.Width - 2, Panel.Height div 2), 'Right side clipped by stale region');
  finally
    DeleteObject(Rgn);
  end;
end;

procedure CheckButtonPixels;
var
  Screen, DC, Bitmap, OldBitmap: THandle;
  Bounds: TRect;
  Y, Borders: Integer;
begin
  Screen := UiGetDC(0); DC := UiCreateDC(Screen); Bitmap := UiCreateBitmap(Screen, ScaleX(100), ScaleY(30)); OldBitmap := SelectObject(DC, Bitmap);
  try
    Bounds.Left := 0; Bounds.Top := 0; Bounds.Right := ScaleX(100); Bounds.Bottom := ScaleY(30);
    DrawBrandButton(WizardForm.CancelButton, DC, Bounds, False, 0, clWhite);
    CheckUi(UiGetPixel(DC, 0, 0) = clWhite, 'Button leaves a rectangle outside its rounded edge');
    Borders := 0;
    for Y := 0 to ScaleY(6) do if UiGetPixel(DC, Bounds.Right div 2, Y) = $0060A5C2 then Borders := Borders + 1;
    CheckUi(Borders = 1, 'Cancel button has multiple or scaled border rows');
    DrawBrandButton(WizardForm.NextButton, DC, Bounds, True, 0, clWhite);
    CheckUi(UiGetPixel(DC, 0, 0) = clWhite, 'Primary button outside background');
    for Y := 0 to ScaleY(6) do CheckUi(UiGetPixel(DC, Bounds.Right div 2, Y) <> $0060A5C2, 'Primary button has an unwanted border');
    CheckUi(UiGetPixel(DC, Bounds.Right div 2, ScaleY(4)) = $002DC6F4, 'Primary fill changed');
  finally
    SelectObject(DC, OldBitmap); DeleteObject(Bitmap); UiDeleteDC(DC); UiReleaseDC(0, Screen);
  end;
end;

procedure CheckCompactLayouts;
var
  Resolution, Zoom, W, H, Dpi: Integer;
begin
  for Resolution := 0 to 3 do
    for Zoom := 0 to 2 do
    begin
      W := 1024; H := 768;
      if Resolution = 1 then begin W := 1280; H := 720; end;
      if Resolution = 2 then begin W := 1366; H := 768; end;
      if Resolution = 3 then begin W := 1920; H := 1080; end;
      Dpi := 96 + Zoom * 48;
      W := W * 7 div 10 * 96 div Dpi;
      H := (H - 40 * Dpi div 96) * 6 div 10 * 96 div Dpi;
      if W > 640 then W := 640;
      if H > 300 then H := 300;
      WizardForm.Width := ScaleX(W); WizardForm.Height := ScaleY(H);
      LayoutDesktopWizard(WizardForm);
      CheckRoundCard(FinishInfo);
      CheckUi(WizardForm.CancelButton.Top >= 0, 'Cancel above window');
      CheckUi(WizardForm.CancelButton.Top + WizardForm.CancelButton.Height <= WizardForm.ClientHeight, 'Cancel below window');
      CheckUi(BrandProgressTrack.Left >= 0, 'Progress outside left edge');
      CheckUi(BrandProgressTrack.Top > WizardForm.StatusLabel.Top + WizardForm.StatusLabel.Height, 'Stage overlaps progress');
      CheckUi(BrandProgressTrack.Left + BrandProgressTrack.Width <= InstallCard.Width, 'Progress outside right edge');
      CheckUi(FinishInfo.Top + FinishInfo.Height <= FinishCard.Height, 'Open option below page');
      if CompactDesktopLayout then
      begin
        CheckUi(CompactSummary.Visible, 'Compact detail scroll pane missing');
        CheckUi(CompactSummary.Height >= ScaleY(16), 'Compact detail text has no readable row');
        CheckUi(FinishDetails.Height >= ScaleY(13), 'Finish explanation has no readable row');
      end;
    end;
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
    if not CompactDesktopLayout then CheckUi(WizardForm.Bevel.Left = ScaleX(144), 'Footer separator crosses the rail');
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
      CheckUi(InstallWarningActive, 'Cancel safety notice missing');
      ManagerOutput('NGT_PROGRESS|' + AttemptId + '|test_transition|0|5|0|0|0|10|100', False, False);
      CheckUi(BrandProgressPosition = 0, 'New phase did not reset its own progress');
    end;
    CheckButtonPixels;
    CheckCompactLayouts;
    SaveStringToFile(Output, 'PASS: native progress, single-border button pixels, both card corners, compact resolution/DPI layouts and scroll panes', False);
    FinishUiTest(0);
  except
    SaveStringToFile(Output, 'FAIL: ' + GetExceptionMessage, False);
    FinishUiTest(1);
  end;
end;
