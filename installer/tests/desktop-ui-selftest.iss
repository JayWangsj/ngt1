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
function UiShowWindow(Wnd: HWND; Command: Integer): BOOL;
  external 'ShowWindow@user32.dll stdcall';
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
  NormalColor, HoverColor, PressedColor: Cardinal;
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
    NormalColor := UiGetPixel(DC, Bounds.Right div 2, ScaleY(4));
    DrawBrandButton(WizardForm.NextButton, DC, Bounds, True, $0040, clWhite);
    HoverColor := UiGetPixel(DC, Bounds.Right div 2, ScaleY(4));
    DrawBrandButton(WizardForm.NextButton, DC, Bounds, True, $0001, clWhite);
    PressedColor := UiGetPixel(DC, Bounds.Right div 2, ScaleY(4));
    CheckUi((NormalColor <> HoverColor) and (HoverColor <> PressedColor), 'Primary hover/pressed colors missing');
    DrawBrandButton(WizardForm.CancelButton, DC, Bounds, False, 0, clWhite);
    NormalColor := UiGetPixel(DC, Bounds.Right div 2, ScaleY(4));
    DrawBrandButton(WizardForm.CancelButton, DC, Bounds, False, $0040, clWhite);
    HoverColor := UiGetPixel(DC, Bounds.Right div 2, ScaleY(4));
    CheckUi(NormalColor <> HoverColor, 'Cancel hover color missing');
  finally
    SelectObject(DC, OldBitmap); DeleteObject(Bitmap); UiDeleteDC(DC); UiReleaseDC(0, Screen);
  end;
end;

procedure CheckCompactLayouts;
var
  Resolution, Zoom, W, H, Dpi, SavedWidth, SavedHeight: Integer;
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
  SavedWidth := InstallCard.Width; SavedHeight := InstallCard.Height;
  UiShowWindow(WizardForm.Handle, 6);
  LayoutDesktopWizard(WizardForm);
  UiShowWindow(WizardForm.Handle, 9);
  UiShowWindow(WizardForm.Handle, 0);
  LayoutDesktopWizard(WizardForm);
  CheckUi((InstallCard.Width = SavedWidth) and (InstallCard.Height = SavedHeight), 'Minimize/restore changed page bounds');
  CheckRoundCard(FinishInfo);
end;

procedure CheckLanguageDialog;
var
  Form: TSetupForm;
  PreviewPath: String;
  PreviewUntil: Int64;
begin
  Form := CreateLanguageDialog;
  try
    CheckUi(Form.Color = clWhite, 'Language dialog must use the wizard page surface');
    CheckUi(LanguageChoice.Color = $00F7FAFB, 'Language selector surface');
    CheckUi(LanguageChoice.Left >= ScaleX(156), 'Language dialog missing brand rail');
    CheckUi(LanguageChoice.Left + LanguageChoice.Width <= Form.ClientWidth - ScaleX(16), 'Language selector overflows');
    CheckUi(LanguageChoice.Top + LanguageChoice.Height < LanguageAccept.Top, 'Language selector overlaps footer');
    CheckUi(LanguageAccept.Height = WizardForm.NextButton.Height, 'Language and wizard button sizes differ');
    SendMessage(LanguageAccept.Handle, $00F4, 1, 1);
    CheckUi((GetWindowLong(LanguageAccept.Handle, -16) and $000F) = $000B, 'Language default button lost branding');
    SendMessage(LanguageCancel.Handle, $0200, 0, 0);
    CheckUi(HoveredBrandButton = LanguageCancel.Handle, 'Language cancel hover missing');
    SendMessage(LanguageCancel.Handle, $02A3, 0, 0);
    PreviewPath := ExpandConstant('{param:UiPreview|}');
    if PreviewPath <> '' then
    begin
      Form.Show;
      ProcessWizardMessages;
      RedrawWindow(Form.Handle, 0, 0, $0185);
      SaveStringToFile(PreviewPath, IntToStr(Form.Handle), False);
      PreviewUntil := GetTickCount64 + 10000;
      while GetTickCount64 < PreviewUntil do
      begin
        ProcessWizardMessages;
        Sleep(20);
      end;
    end;
  finally
    SetWindowLong(Form.Handle, -4, OriginalLanguageProc);
    OriginalLanguageProc := 0; LanguageDialogHandle := 0;
    Form.Free;
  end;
end;

procedure RunDesktopUiSelfTests;
var
  Tick: Int64;
  Phases: TArrayOfString;
  I, Loads, Layouts: Integer;
  Output: String;
begin
  Output := ExpandConstant('{param:UiTestResult|}');
  try
    CheckUi(InstallRail.Parent = WizardForm, 'Brand rail must extend through the footer');
    CheckUi(InstallRail.Height = WizardForm.ClientHeight, 'Brand rail height');
    if not CompactDesktopLayout then CheckUi(WizardForm.Bevel.Left = ScaleX(144), 'Footer separator crosses the rail');
    CheckUi(WizardForm.RunList.Parent = FinishInfo, 'Open option parent');
    CheckUi(WizardForm.RunList.Color = FinishInfo.Color, 'Open option background');
    SendMessage(WizardForm.NextButton.Handle, $00F4, 1, 1);
    CheckUi((GetWindowLong(WizardForm.NextButton.Handle, -16) and $000F) = $000B, 'Default-button change restored the native gray button');
    SendMessage(WizardForm.CancelButton.Handle, $0200, 0, 0);
    CheckUi(HoveredBrandButton = WizardForm.CancelButton.Handle, 'Mouse move does not set hover');
    SendMessage(WizardForm.CancelButton.Handle, $02A3, 0, 0);
    CheckUi(HoveredBrandButton = 0, 'Mouse leave does not clear hover');
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
      Loads := StageIconLoads; Layouts := DesktopLayoutCount;
      ManagerOutput('NGT_PROGRESS|' + AttemptId + '|' + Phases[I] + '|2|2|0|2|20||', False, False);
      CheckUi(StageIconLoads = Loads, 'Heartbeat reloads the stage bitmap');
      CheckUi(DesktopLayoutCount = Layouts, 'Heartbeat relayouts and erases the page');
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
    ManagerOutput('NGT_PROGRESS|' + AttemptId + '|package_source_verification|40|40|0|10|100|20|200', False, False);
    Loads := StageIconLoads;
    ManagerOutput('NGT_PROGRESS|' + AttemptId + '|package_source_verification|41|41|0|11|110|20|200', False, False);
    CheckUi(StageIconLoads = Loads, 'Slow-stage clock reloads every heartbeat');
    InstallMetrics.Visible := False;
    ManagerOutput('NGT_PROGRESS|' + AttemptId + '|package_source_verification|42|42|0|12|120|20|200', False, False);
    CheckUi(not InstallMetrics.Visible, 'Progress redraw revealed hidden metrics');
    InstallMetrics.Visible := True;
    CheckLanguageDialog;
    CheckCompactLayouts;
    SaveStringToFile(Output, 'PASS: stable heartbeat rendering, button hover/pressed/default styles, branded language dialog, progress, card corners, compact layouts and minimize/restore', False);
    FinishUiTest(0);
  except
    SaveStringToFile(Output, 'FAIL: ' + GetExceptionMessage, False);
    FinishUiTest(1);
  end;
end;
