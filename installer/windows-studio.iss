#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef PackageDirectory
  #error PackageDirectory is required
#endif
#ifndef IconPath
  #error IconPath is required
#endif
#ifndef IconBitmapPath
  #error IconBitmapPath is required
#endif
#ifndef RailBitmapPath
  #error RailBitmapPath is required
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
ShowLanguageDialog=no
DefaultDialogFontName=Segoe UI
CloseApplications=no
RestartApplications=no
UninstallDisplayName={#AppName}
UninstallDisplayIcon={localappdata}\NGTManager\assets\ngt-studio.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "italian"; MessagesFile: "compiler:Languages\Italian.isl"
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"

[Files]
Source: "{#IconBitmapPath}"; Flags: dontcopy
Source: "{#RailBitmapPath}"; Flags: dontcopy
Source: "..\assets\ngt-studio-installer-white.bmp"; Flags: dontcopy
Source: "..\assets\ngt-stage-*.bmp"; Flags: dontcopy
Source: "..\assets\ngt-metric-*.bmp"; Flags: dontcopy
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
  TDesktopMonitorInfo = record
    Size: DWORD;
    Monitor, Work: TRect;
    Flags: DWORD;
  end;
  TButtonDrawItem = record
    ControlType, ControlId, ItemId, Action, State: Cardinal;
    Window, DC: THandle;
    Bounds: TRect;
    ItemData: LongWord;
  end;
  TMouseTracking = record
    Size, Flags: Cardinal;
    Window: HWND;
    HoverTime: Cardinal;
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
  InstallRail: TPanel;
  InstallRailBackground: TBitmapImage;
  InstallMetrics: TPanel;
  InstallBrandImage: TBitmapImage;
  BrandRailBitmap, BrandPageBitmap: TBitmapImage;
  BrandAssetsOnWhite: Boolean;
  InstallBrandLabel: TNewStaticText;
  InstallVersionLabel: TNewStaticText;
  InstallEyebrowLabel: TNewStaticText;
  InstallStageIconPanel: TPanel;
  InstallStageIconLabel: TNewStaticText;
  InstallStageImage: TBitmapImage;
  InstallDescriptionLabel: TNewStaticText;
  InstallWarningLabel: TNewStaticText;
  InstallFilesLabel: TNewStaticText;
  InstallFilesValue: TNewStaticText;
  InstallTotalLabel: TNewStaticText;
  InstallTotalValue: TNewStaticText;
  InstallPhaseLabel: TNewStaticText;
  InstallPhaseValue: TNewStaticText;
  FailureDetails: TNewMemo;
  CompactSummary, FinishDetails: TNewMemo;
  CompactDesktopLayout, LayingOutDesktop, InstallWarningActive: Boolean;
  BrandProgressTrack: TPanel;
  BrandProgressFill: TPanel;
  FinishCard: TPanel;
  FinishRail: TPanel;
  FinishRailBackground: TBitmapImage;
  FinishBrandImage: TBitmapImage;
  FinishInfo: TPanel;
  FinishBrandLabel: TNewStaticText;
  FinishVersionLabel: TNewStaticText;
  BrandProgressDeterminate: Boolean;
  BrandProgressPosition: Integer;
  BrandProgressAnimationTick: Int64;
  DesktopLayoutReady: Boolean;
  ActiveBrandPage: Integer;
  ReadyCard: TPanel;
  ReadyHeading: TNewStaticText;
  ReadyDescription: TNewStaticText;
  ReadyBrand: TBitmapImage;
  ReadyRail: TPanel;
  ReadyStage: TBitmapImage;
  ReadyProduct: TNewStaticText;
  ReadyEyebrow: TNewStaticText;
  FinishStage: TBitmapImage;
  MetricIcons: array[0..2] of TBitmapImage;
  MetricDividers: array[0..1] of TPanel;
  MetricSurface: TPanel;
  OriginalWizardProc, OriginalLanguageProc: LongInt;
  LanguageDialogHandle: HWND;
  LanguageAccept, LanguageCancel: TNewButton;
  LanguageChoice: TNewComboBox;
  HoveredBrandButton: HWND;
  BrandButtonCallback: LongInt;
  CurrentStageIcon: String;
#ifdef DesktopUiTest
  StageIconLoads, DesktopLayoutCount: Integer;
#endif

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

function GetWindowLong(Wnd: HWND; Index: Integer): LongInt;
  external 'GetWindowLongW@user32.dll stdcall';
function SetWindowLong(Wnd: HWND; Index: Integer; Value: LongInt): LongInt;
  external 'SetWindowLongW@user32.dll stdcall';
function CallWindowProc(Previous: LongInt; Wnd: HWND; Msg: UINT; WParam: LongWord; LParam: LongInt): LongInt;
  external 'CallWindowProcW@user32.dll stdcall';
procedure ReadDrawItem(var Item: TButtonDrawItem; Source: LongInt; Count: Cardinal);
  external 'RtlMoveMemory@kernel32.dll stdcall';
function CreateSolidBrush(Color: Cardinal): THandle;
  external 'CreateSolidBrush@gdi32.dll stdcall';
function CreatePen(Style, Width: Integer; Color: Cardinal): THandle;
  external 'CreatePen@gdi32.dll stdcall';
function SelectObject(DC, Item: THandle): THandle;
  external 'SelectObject@gdi32.dll stdcall';
function DeleteObject(Item: THandle): BOOL;
  external 'DeleteObject@gdi32.dll stdcall';
function FillRect(DC: THandle; const Bounds: TRect; Brush: THandle): Integer;
  external 'FillRect@user32.dll stdcall';
function RoundRect(DC: THandle; Left, Top, Right, Bottom, RadiusX, RadiusY: Integer): BOOL;
  external 'RoundRect@gdi32.dll stdcall';
function SetBkMode(DC: THandle; Mode: Integer): Integer;
  external 'SetBkMode@gdi32.dll stdcall';
function SetTextColor(DC: THandle; Color: Cardinal): Cardinal;
  external 'SetTextColor@gdi32.dll stdcall';
function DrawText(DC: THandle; Text: String; Count: Integer; var Bounds: TRect; Format: Cardinal): Integer;
  external 'DrawTextW@user32.dll stdcall';
function GetStockObject(Index: Integer): THandle;
  external 'GetStockObject@gdi32.dll stdcall';
function SetWindowSubclass(Wnd: HWND; Callback: LongInt; Id, Data: LongWord): BOOL;
  external 'SetWindowSubclass@comctl32.dll stdcall';
function DefSubclassProc(Wnd: HWND; Msg: UINT; WParam: LongWord; LParam: LongInt): LongInt;
  external 'DefSubclassProc@comctl32.dll stdcall';
function TrackMouseEvent(var Tracking: TMouseTracking): BOOL;
  external 'TrackMouseEvent@user32.dll stdcall';
function InvalidateRect(Wnd: HWND; Rect: LongInt; Erase: BOOL): BOOL;
  external 'InvalidateRect@user32.dll stdcall';
function RedrawWindow(Wnd: HWND; Rect, Region: LongInt; Flags: UINT): BOOL;
  external 'RedrawWindow@user32.dll stdcall';

function UiGetWindowRect(Wnd: HWND; var Bounds: TRect): BOOL;
  external 'GetWindowRect@user32.dll stdcall';
function UiSetWindowPos(Wnd, After: HWND; X, Y, W, H: Integer; Flags: UINT): BOOL;
  external 'SetWindowPos@user32.dll stdcall';
procedure FitDesktopWindow(Wnd: HWND); forward;
procedure LayoutDesktopWizard(Sender: TObject); forward;

function ButtonShowsKeyboardFocus(Button: TNewButton; State: Cardinal): Boolean;
begin
  Result := ((State and $0010) <> 0) and ((State and $0200) = 0) and
    ((SendMessage(Button.Handle, $0129, 0, 0) and 1) = 0);
end;

procedure DrawBrandButton(Button: TNewButton; DC: THandle; Bounds: TRect; Primary: Boolean; State: Cardinal; Background: TColor);
var
  Brush, Pen, OldBrush, OldPen, OldFont, ClearBrush: THandle;
  OwnedPen: Boolean;
  TextBounds: TRect;
  Text: String;
begin
  ClearBrush := CreateSolidBrush(Background);
  FillRect(DC, Bounds, ClearBrush); DeleteObject(ClearBrush);
  if not Button.Enabled then Brush := CreateSolidBrush($00E9E7E1)
  else if Primary and ((State and $0001) <> 0) then Brush := CreateSolidBrush($0026B0DC)
  else if (State and $0001) <> 0 then Brush := CreateSolidBrush($00B0DCEB)
  else if Primary and ((State and $0040) <> 0) then Brush := CreateSolidBrush($0020B6E6)
  else if Primary then Brush := CreateSolidBrush($002DC6F4)
  else if (State and $0040) <> 0 then Brush := CreateSolidBrush($00E7F3FA)
  else Brush := CreateSolidBrush($00F7FAFB);
  OwnedPen := (not Primary) or ButtonShowsKeyboardFocus(Button, State);
  Pen := GetStockObject(8);
  if OwnedPen then
  begin
    if ButtonShowsKeyboardFocus(Button, State) then Pen := CreatePen(0, 1, $0022677E)
    else Pen := CreatePen(0, 1, $0060A5C2);
  end;
  OldBrush := SelectObject(DC, Brush); OldPen := SelectObject(DC, Pen);
  RoundRect(DC, Bounds.Left + 1, Bounds.Top + 1, Bounds.Right - 1, Bounds.Bottom - 1, ScaleX(16), ScaleY(16));
  SetBkMode(DC, 1); SetTextColor(DC, $001F2729);
  OldFont := SelectObject(DC, SendMessage(Button.Handle, $0031, 0, 0));
  Text := Button.Caption; TextBounds := Bounds;
  DrawText(DC, Text, Length(Text), TextBounds, $0001 or $0004 or $0020);
  SelectObject(DC, OldFont); SelectObject(DC, OldBrush); SelectObject(DC, OldPen);
  DeleteObject(Brush); if OwnedPen then DeleteObject(Pen);
end;

function BrandButtonWindowProc(Wnd: HWND; Msg: UINT; WParam: LongWord; LParam: LongInt): LongInt;
var
  Item: TButtonDrawItem;
  Button: TNewButton;
  Primary: Boolean;
  Previous: LongInt;
  Background: TColor;
begin
  if Wnd = LanguageDialogHandle then begin Previous := OriginalLanguageProc; Background := $00F7FAFB; end
  else begin Previous := OriginalWizardProc; Background := WizardForm.Color; end;
  if Msg = $002B then
  begin
    ReadDrawItem(Item, LParam, SizeOf(Item)); Button := nil; Primary := False;
    if Wnd = LanguageDialogHandle then
    begin
      if Item.Window = LanguageAccept.Handle then begin Button := LanguageAccept; Primary := True; end
      else if Item.Window = LanguageCancel.Handle then Button := LanguageCancel;
    end
    else
    begin
      if Item.Window = WizardForm.NextButton.Handle then begin Button := WizardForm.NextButton; Primary := True; end
      else if Item.Window = WizardForm.CancelButton.Handle then Button := WizardForm.CancelButton;
    end;
    if Button <> nil then
    begin
      if HoveredBrandButton = Button.Handle then Item.State := Item.State or $0040;
      DrawBrandButton(Button, Item.DC, Item.Bounds, Primary, Item.State, Background);
      Result := 1; Exit;
    end;
  end;
  Result := CallWindowProc(Previous, Wnd, Msg, WParam, LParam);
  if (Msg = $0232) or (Msg = $001A) then
  begin
    FitDesktopWindow(Wnd);
    if DesktopLayoutReady and (Wnd = WizardForm.Handle) then LayoutDesktopWizard(WizardForm);
  end;
end;

function BrandButtonSubclass(Wnd: HWND; Msg: UINT; WParam: LongWord; LParam: LongInt; Id, Data: LongWord): LongInt;
var
  Tracking: TMouseTracking;
begin
  { Inno changes the default-button style when focus/page changes. Keep owner draw. }
  if Msg = $00F4 then
  begin
    Result := DefSubclassProc(Wnd, Msg, (WParam and not $000F) or $000B, LParam);
    Exit;
  end;
  if Msg = $0200 then
  begin
    if HoveredBrandButton <> Wnd then
    begin
      HoveredBrandButton := Wnd;
      InvalidateRect(Wnd, 0, False);
      Tracking.Size := SizeOf(Tracking); Tracking.Flags := 2;
      Tracking.Window := Wnd; Tracking.HoverTime := 0;
      TrackMouseEvent(Tracking);
    end;
  end
  else if (Msg = $02A3) or (Msg = $0082) then
  begin
    if HoveredBrandButton = Wnd then HoveredBrandButton := 0;
    InvalidateRect(Wnd, 0, False);
  end;
  Result := DefSubclassProc(Wnd, Msg, WParam, LParam);
end;

procedure UseBrandButton(Button: TNewButton);
begin
  if HighContrastActive then Exit;
  if BrandButtonCallback = 0 then BrandButtonCallback := CreateCallback(@BrandButtonSubclass);
  SetWindowSubclass(Button.Handle, BrandButtonCallback, 1, 0);
  if (GetWindowLong(Button.Handle, -16) and $000F) <> $000B then
  begin
    SetWindowLong(Button.Handle, -16, (GetWindowLong(Button.Handle, -16) and not ($000F or $00800000)) or $000B);
    SetWindowLong(Button.Handle, -20, GetWindowLong(Button.Handle, -20) and not ($0200 or $00020000));
    Button.Invalidate;
  end;
end;

function SystemParametersInfo(Action, Param: UINT; var Area: TRect; Flags: UINT): BOOL;
  external 'SystemParametersInfoW@user32.dll stdcall';

function MonitorFromWindow(Wnd: HWND; Flags: DWORD): THandle;
  external 'MonitorFromWindow@user32.dll stdcall';
function GetDesktopMonitorInfo(Monitor: THandle; var Info: TDesktopMonitorInfo): BOOL;
  external 'GetMonitorInfoW@user32.dll stdcall';

function DesktopWorkArea(Wnd: HWND; var Area: TRect): Boolean;
var
  Info: TDesktopMonitorInfo;
begin
  Info.Size := SizeOf(Info);
  Result := GetDesktopMonitorInfo(MonitorFromWindow(Wnd, 2), Info);
  if Result then Area := Info.Work
  else Result := SystemParametersInfo(48, 0, Area, 0);
end;

procedure FitDesktopWindow(Wnd: HWND);
var
  Area, Bounds: TRect;
  W, H, X, Y: Integer;
begin
  if not DesktopWorkArea(Wnd, Area) then Exit;
  if not UiGetWindowRect(Wnd, Bounds) then Exit;
  W := Bounds.Right - Bounds.Left; H := Bounds.Bottom - Bounds.Top;
  if W > (Area.Right - Area.Left) * 7 div 10 then W := (Area.Right - Area.Left) * 7 div 10;
  if H > (Area.Bottom - Area.Top) * 6 div 10 then H := (Area.Bottom - Area.Top) * 6 div 10;
  X := Bounds.Left; Y := Bounds.Top;
  if X < Area.Left then X := Area.Left;
  if Y < Area.Top then Y := Area.Top;
  if X + W > Area.Right then X := Area.Right - W;
  if Y + H > Area.Bottom then Y := Area.Bottom - H;
  if (X <> Bounds.Left) or (Y <> Bounds.Top) or (W <> Bounds.Right - Bounds.Left) or (H <> Bounds.Bottom - Bounds.Top) then
    UiSetWindowPos(Wnd, 0, X, Y, W, H, $0004 or $0010);
end;

procedure ApplyRoundedCard(Panel: TPanel); forward;
procedure UpdateCompactDetails; forward;
#ifdef DesktopUiTest
procedure RunDesktopUiSelfTests; forward;
#endif

procedure LayoutDesktopWizard(Sender: TObject);
var
  Area: TRect;
  W, H, LeftEdge, ContentWidth, ColumnWidth, I, StageY, IconSize, TextLeft, DetailY, ProgressY, InfoY: Integer;
  ShowBrandRail, ShowBrandHeader: Boolean;
begin
  if (not DesktopLayoutReady) or LayingOutDesktop then Exit;
#ifdef DesktopUiTest
  DesktopLayoutCount := DesktopLayoutCount + 1;
#endif
  LayingOutDesktop := True;
  try
    if DesktopWorkArea(WizardForm.Handle, Area) then
    begin
      if WizardForm.Width > (Area.Right - Area.Left) * 7 div 10 then WizardForm.Width := (Area.Right - Area.Left) * 7 div 10;
      if WizardForm.Height > (Area.Bottom - Area.Top) * 6 div 10 then WizardForm.Height := (Area.Bottom - Area.Top) * 6 div 10;
    end;
    WizardForm.OuterNotebook.SetBounds(0, 0, WizardForm.ClientWidth, WizardForm.ClientHeight - ScaleY(48));
    WizardForm.InnerNotebook.SetBounds(0, 0, WizardForm.OuterNotebook.Width, WizardForm.OuterNotebook.Height);
    W := WizardForm.InstallingPage.ClientWidth;
    H := WizardForm.InstallingPage.ClientHeight;
    InstallCard.SetBounds(0, 0, W, H);
    FinishCard.SetBounds(0, 0, W, H);
    ReadyCard.SetBounds(0, 0, W, H);
    CompactDesktopLayout := (W < ScaleX(580)) or (WizardForm.ClientHeight < ScaleY(220)) or (H < ScaleY(208));
    ShowBrandRail := not CompactDesktopLayout;
    if BrandAssetsOnWhite <> CompactDesktopLayout then
    begin
      if CompactDesktopLayout then
      begin
        InstallBrandImage.Bitmap.Assign(BrandPageBitmap.Bitmap); FinishBrandImage.Bitmap.Assign(BrandPageBitmap.Bitmap); ReadyBrand.Bitmap.Assign(BrandPageBitmap.Bitmap);
      end
      else
      begin
        InstallBrandImage.Bitmap.Assign(BrandRailBitmap.Bitmap); FinishBrandImage.Bitmap.Assign(BrandRailBitmap.Bitmap); ReadyBrand.Bitmap.Assign(BrandRailBitmap.Bitmap);
      end;
      BrandAssetsOnWhite := CompactDesktopLayout;
    end;
    ShowBrandHeader := CompactDesktopLayout and (H >= ScaleY(172));
    LeftEdge := ScaleX(164);
    StageY := ScaleY(36);
    IconSize := ScaleX(40);
    if CompactDesktopLayout then
    begin
      LeftEdge := ScaleX(12);
      StageY := ScaleY(8);
      if ShowBrandHeader then StageY := ScaleY(52);
      IconSize := ScaleX(24);
    end;
    ContentWidth := W - LeftEdge - ScaleX(16);
    TextLeft := LeftEdge + IconSize + ScaleX(8);
    for I := 0 to 2 do
    begin
      if I = 0 then begin InstallRail.SetBounds(0, 0, ScaleX(144), WizardForm.ClientHeight); end;
      if I = 1 then begin FinishRail.SetBounds(0, 0, ScaleX(144), WizardForm.ClientHeight); end;
      if I = 2 then begin ReadyRail.SetBounds(0, 0, ScaleX(144), WizardForm.ClientHeight); end;
    end;
    if ShowBrandRail then
    begin
      InstallBrandImage.Parent := InstallRail; FinishBrandImage.Parent := FinishRail; ReadyBrand.Parent := ReadyRail;
      InstallBrandLabel.Parent := InstallRail; FinishBrandLabel.Parent := FinishRail; ReadyProduct.Parent := ReadyRail;
      InstallBrandImage.SetBounds(ScaleX(24), ScaleY(20), ScaleX(48), ScaleY(48));
      FinishBrandImage.SetBounds(ScaleX(24), ScaleY(20), ScaleX(48), ScaleY(48));
      ReadyBrand.SetBounds(ScaleX(24), ScaleY(20), ScaleX(48), ScaleY(48));
      InstallBrandLabel.SetBounds(ScaleX(16), ScaleY(80), ScaleX(128), ScaleY(26));
      FinishBrandLabel.SetBounds(ScaleX(16), ScaleY(80), ScaleX(128), ScaleY(26));
      ReadyProduct.SetBounds(ScaleX(16), ScaleY(80), ScaleX(128), ScaleY(26));
      InstallBrandLabel.Caption := 'NGTManager'; FinishBrandLabel.Caption := 'NGTManager'; ReadyProduct.Caption := 'NGTManager';
    end
    else
    begin
      InstallBrandImage.Parent := InstallCard; FinishBrandImage.Parent := FinishCard; ReadyBrand.Parent := ReadyCard;
      InstallBrandLabel.Parent := InstallCard; FinishBrandLabel.Parent := FinishCard; ReadyProduct.Parent := ReadyCard;
      InstallBrandImage.SetBounds(ScaleX(12), ScaleY(8), ScaleX(32), ScaleY(32));
      FinishBrandImage.SetBounds(ScaleX(12), ScaleY(8), ScaleX(32), ScaleY(32));
      ReadyBrand.SetBounds(ScaleX(12), ScaleY(8), ScaleX(32), ScaleY(32));
      InstallBrandLabel.SetBounds(ScaleX(56), ScaleY(12), W - ScaleX(68), ScaleY(24));
      FinishBrandLabel.SetBounds(ScaleX(56), ScaleY(12), W - ScaleX(68), ScaleY(24));
      ReadyProduct.SetBounds(ScaleX(56), ScaleY(12), W - ScaleX(68), ScaleY(24));
      InstallBrandLabel.Caption := 'NGTManager  v{#AppVersion}'; FinishBrandLabel.Caption := InstallBrandLabel.Caption; ReadyProduct.Caption := InstallBrandLabel.Caption;
    end;
    InstallBrandImage.Visible := ShowBrandRail or ShowBrandHeader; InstallBrandLabel.Visible := InstallBrandImage.Visible;
    FinishBrandImage.Visible := InstallBrandImage.Visible; FinishBrandLabel.Visible := InstallBrandImage.Visible;
    ReadyBrand.Visible := InstallBrandImage.Visible; ReadyProduct.Visible := InstallBrandImage.Visible;
    InstallRail.Visible := ShowBrandRail and (ActiveBrandPage = wpInstalling);
    FinishRail.Visible := ShowBrandRail and (ActiveBrandPage = wpFinished);
    ReadyRail.Visible := ShowBrandRail and (ActiveBrandPage = wpReady);
    if InstallRail.Visible then InstallRail.BringToFront;
    if FinishRail.Visible then FinishRail.BringToFront;
    if ReadyRail.Visible then ReadyRail.BringToFront;
    InstallEyebrowLabel.Visible := ShowBrandRail; InstallEyebrowLabel.SetBounds(LeftEdge, ScaleY(12), ContentWidth, ScaleY(18));
    ReadyEyebrow.Visible := ShowBrandRail; ReadyEyebrow.SetBounds(LeftEdge, ScaleY(12), ContentWidth, ScaleY(18));
    InstallStageIconPanel.SetBounds(LeftEdge, StageY, IconSize, IconSize);
    InstallStageImage.SetBounds(0, 0, IconSize, IconSize);
    InstallStageIconPanel.Color := InstallCard.Color;
    ApplyRoundedCard(InstallStageIconPanel);
    ReadyStage.SetBounds(LeftEdge, StageY, IconSize, IconSize);
    FinishStage.SetBounds(LeftEdge, StageY, IconSize, IconSize);
    WizardForm.StatusLabel.SetBounds(TextLeft, StageY, W - TextLeft - ScaleX(16), ScaleY(28));
    ReadyHeading.SetBounds(TextLeft, StageY, W - TextLeft - ScaleX(16), ScaleY(28));
    WizardForm.FinishedHeadingLabel.SetBounds(TextLeft, StageY, W - TextLeft - ScaleX(16), ScaleY(28));
    DetailY := StageY + ScaleY(32);
    ProgressY := H - ScaleY(86);
    if CompactDesktopLayout then ProgressY := H - ScaleY(16);
    BrandProgressTrack.SetBounds(LeftEdge, ProgressY, ContentWidth, ScaleY(8));
    ApplyRoundedCard(BrandProgressTrack);
    InstallDescriptionLabel.SetBounds(TextLeft, DetailY, W - TextLeft - ScaleX(16), ScaleY(32));
    InstallDescriptionLabel.Visible := (not CompactDesktopLayout) and (not FailureDetails.Visible);
    InstallWarningLabel.SetBounds(LeftEdge, ProgressY - ScaleY(22), ContentWidth, ScaleY(18));
    InstallWarningLabel.Visible := InstallWarningActive and (not CompactDesktopLayout) and (not FailureDetails.Visible);
    InstallMetrics.SetBounds(LeftEdge, H - ScaleY(66), ContentWidth, ScaleY(54));
    if CompactDesktopLayout then InstallMetrics.SetBounds(LeftEdge, DetailY, ContentWidth, ProgressY - DetailY - ScaleY(8));
    InstallMetrics.Visible := not FailureDetails.Visible;
    MetricSurface.SetBounds(ScaleX(1), ScaleY(1), InstallMetrics.Width - ScaleX(2), InstallMetrics.Height - ScaleY(2));
    ApplyRoundedCard(InstallMetrics); ApplyRoundedCard(MetricSurface);
    CompactSummary.SetBounds(ScaleX(8), ScaleY(4), MetricSurface.ClientWidth - ScaleX(16), MetricSurface.ClientHeight - ScaleY(8));
    CompactSummary.Visible := CompactDesktopLayout;
    InstallFilesLabel.Visible := not CompactDesktopLayout; InstallFilesValue.Visible := not CompactDesktopLayout;
    InstallTotalLabel.Visible := not CompactDesktopLayout; InstallTotalValue.Visible := not CompactDesktopLayout;
    InstallPhaseLabel.Visible := not CompactDesktopLayout; InstallPhaseValue.Visible := not CompactDesktopLayout;
    ColumnWidth := ContentWidth div 3;
    InstallFilesLabel.SetBounds(ScaleX(36), ScaleY(6), ColumnWidth - ScaleX(40), ScaleY(18)); InstallFilesValue.SetBounds(ScaleX(36), ScaleY(26), ColumnWidth - ScaleX(40), ScaleY(22));
    InstallTotalLabel.SetBounds(ColumnWidth + ScaleX(36), ScaleY(6), ColumnWidth - ScaleX(40), ScaleY(18)); InstallTotalValue.SetBounds(InstallTotalLabel.Left, ScaleY(26), ColumnWidth - ScaleX(40), ScaleY(22));
    InstallPhaseLabel.SetBounds(ColumnWidth * 2 + ScaleX(36), ScaleY(6), ColumnWidth - ScaleX(40), ScaleY(18)); InstallPhaseValue.SetBounds(InstallPhaseLabel.Left, ScaleY(26), ColumnWidth - ScaleX(40), ScaleY(22));
    for I := 0 to 2 do begin MetricIcons[I].Visible := not CompactDesktopLayout; MetricIcons[I].SetBounds(ColumnWidth * I + ScaleX(10), ScaleY(16), ScaleX(20), ScaleY(20)); end;
    for I := 0 to 1 do begin MetricDividers[I].Visible := not CompactDesktopLayout; MetricDividers[I].SetBounds(ColumnWidth * (I + 1), ScaleY(12), ScaleX(1), ScaleY(30)); end;
    FailureDetails.SetBounds(LeftEdge, DetailY, ContentWidth, H - DetailY - ScaleY(12));
    ReadyDescription.SetBounds(TextLeft, DetailY, W - TextLeft - ScaleX(16), H - DetailY - ScaleY(12));
    InfoY := ScaleY(132);
    if CompactDesktopLayout then InfoY := H - ScaleY(44);
    FinishInfo.SetBounds(LeftEdge, InfoY, ContentWidth, ScaleY(32));
    if not CompactDesktopLayout then FinishInfo.Height := ScaleY(56);
    ApplyRoundedCard(FinishInfo);
    WizardForm.RunList.SetBounds(ScaleX(12), (FinishInfo.Height - ScaleY(24)) div 2, ContentWidth - ScaleX(24), ScaleY(24));
    WizardForm.FinishedLabel.SetBounds(TextLeft, DetailY, W - TextLeft - ScaleX(16), InfoY - DetailY - ScaleY(8));
    WizardForm.FinishedLabel.Visible := not CompactDesktopLayout;
    FinishDetails.SetBounds(LeftEdge, DetailY, ContentWidth, InfoY - DetailY - ScaleY(4)); FinishDetails.Visible := CompactDesktopLayout;
    UpdateCompactDetails;
    WizardForm.Bevel.Left := 0; if ShowBrandRail then WizardForm.Bevel.Left := ScaleX(144);
    WizardForm.Bevel.SetBounds(WizardForm.Bevel.Left, WizardForm.ClientHeight - ScaleY(48), WizardForm.ClientWidth - WizardForm.Bevel.Left, ScaleY(1));
    WizardForm.CancelButton.SetBounds(WizardForm.ClientWidth - ScaleX(116), WizardForm.ClientHeight - ScaleY(39), ScaleX(100), ScaleY(30));
    WizardForm.NextButton.SetBounds(WizardForm.CancelButton.Left - ScaleX(108), WizardForm.CancelButton.Top, ScaleX(100), ScaleY(30));
    if not WizardForm.CancelButton.Visible then WizardForm.NextButton.Left := WizardForm.CancelButton.Left;
    WizardForm.BackButton.SetBounds(WizardForm.NextButton.Left - ScaleX(108), WizardForm.CancelButton.Top, ScaleX(100), ScaleY(30));
  finally
    LayingOutDesktop := False;
  end;
end;

function UiText(const Chinese, Italian, English: String): String;
begin
  if ActiveLanguage = 'italian' then
    Result := Italian
  else if ActiveLanguage = 'chinesesimplified' then
    Result := Chinese
  else
    Result := English;
end;

procedure UpdateCompactDetails;
var
  Text: String;
  FirstLine: LongInt;
begin
  if CompactSummary = nil then Exit;
  Text := InstallDescriptionLabel.Caption + #13#10;
  if InstallWarningActive then Text := InstallWarningLabel.Caption + #13#10 + Text;
  Text := Text + InstallFilesLabel.Caption + ': ' + InstallFilesValue.Caption + #13#10 + InstallTotalLabel.Caption + ': ' + InstallTotalValue.Caption + #13#10 + InstallPhaseLabel.Caption + ': ' + InstallPhaseValue.Caption;
  if CompactSummary.Text <> Text then
  begin
    FirstLine := SendMessage(CompactSummary.Handle, $00CE, 0, 0);
    CompactSummary.Text := Text;
    SendMessage(CompactSummary.Handle, $00B6, 0, FirstLine);
  end;
  if FinishDetails.Text <> WizardForm.FinishedLabel.Caption then FinishDetails.Text := WizardForm.FinishedLabel.Caption;
end;

function ShellUsesLightTheme: Boolean;
var
  ThemeValue: Cardinal;
begin
  Result := True;
  if RegQueryDWordValue(HKCU,
    'Software\Microsoft\Windows\CurrentVersion\Themes\Personalize',
    'SystemUsesLightTheme', ThemeValue) then
    Result := ThemeValue <> 0;
end;

function TwoDigits(Value: Integer): String;
begin
  if Value < 10 then
    Result := '0' + IntToStr(Value)
  else
    Result := IntToStr(Value);
end;

function ElapsedText(Seconds: Integer): String;
begin
  Result := TwoDigits(Seconds div 60) + ':' + TwoDigits(Seconds mod 60);
end;

procedure ApplyRoundedCard(Panel: TPanel);
var
  Region: THandle;
  Diameter: Integer;
begin
  Diameter := ScaleX(28);
  if Diameter > Panel.Height then Diameter := Panel.Height;
  Region := CreateRoundRectRgn(0, 0, Panel.Width, Panel.Height,
    Diameter, Diameter);
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
  if (Value * 1000) div Total > BrandProgressPosition then
    BrandProgressPosition := (Value * 1000) div Total;
  AvailableWidth := BrandProgressTrack.ClientWidth;
  BrandProgressFill.Left := 0;
  BrandProgressFill.Width := (AvailableWidth * BrandProgressPosition) div 1000;
  ApplyRoundedCard(BrandProgressFill);
end;

procedure SetBrandProgressActive;
begin
  if BrandProgressDeterminate then BrandProgressAnimationTick := GetTickCount64;
  BrandProgressDeterminate := False;
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
  ApplyRoundedCard(BrandProgressFill);
  BrandProgressFill.Left := ((GetTickCount64 - BrandProgressAnimationTick) div 6) mod Travel - SegmentWidth;
end;

procedure ApplyDesktopTheme;
var
  ContentWidth, I: Integer;
  VersionCapsule: TPanel;
  ReadyBackground: TBitmapImage;
  ReadyVersion: TNewStaticText;
begin
  BrandRailBitmap := TBitmapImage.Create(WizardForm); BrandRailBitmap.Visible := False; BrandRailBitmap.Bitmap.LoadFromFile(ExpandConstant('{tmp}\ngt-studio-installer.bmp'));
  BrandPageBitmap := TBitmapImage.Create(WizardForm); BrandPageBitmap.Visible := False; BrandPageBitmap.Bitmap.LoadFromFile(ExpandConstant('{tmp}\ngt-studio-installer-white.bmp'));
  WizardForm.Width := ScaleX(640);
  WizardForm.Height := ScaleY(300);
  WizardForm.NextButton.Width := ScaleX(108);
  WizardForm.NextButton.Height := ScaleY(32);
  WizardForm.CancelButton.Width := ScaleX(108);
  WizardForm.CancelButton.Height := ScaleY(32);
  WizardForm.OuterNotebook.SetBounds(0, 0, WizardForm.ClientWidth,
    WizardForm.ClientHeight - ScaleY(60));
  WizardForm.InnerNotebook.SetBounds(0, 0, WizardForm.OuterNotebook.Width,
    WizardForm.OuterNotebook.Height);
  WizardForm.Bevel.Top := WizardForm.ClientHeight - ScaleY(60);
  WizardForm.CancelButton.Top := WizardForm.ClientHeight - ScaleY(44);
  WizardForm.CancelButton.Left := WizardForm.ClientWidth - WizardForm.CancelButton.Width - ScaleX(20);
  WizardForm.NextButton.Top := WizardForm.CancelButton.Top;
  WizardForm.NextButton.Left := WizardForm.CancelButton.Left - WizardForm.NextButton.Width - ScaleX(8);
  WizardForm.BackButton.Top := WizardForm.CancelButton.Top;
  WizardForm.BackButton.Left := WizardForm.NextButton.Left - WizardForm.BackButton.Width - ScaleX(8);
  WizardForm.Color := clWhite;
  WizardForm.Font.Name := 'Segoe UI';
  WizardForm.InnerPage.Color := clWhite;
  WizardForm.MainPanel.Visible := False;
  WizardForm.WizardBitmapImage.Visible := False;
  WizardForm.WizardSmallBitmapImage.Visible := False;

  ContentWidth := WizardForm.InstallingPage.ClientWidth - ScaleX(180);
  InstallCard := TPanel.Create(WizardForm);
  InstallCard.Parent := WizardForm.InstallingPage;
  InstallCard.SetBounds(0, 0, WizardForm.InstallingPage.ClientWidth,
    WizardForm.InstallingPage.ClientHeight);
  InstallCard.BevelOuter := bvNone;
  InstallCard.ParentBackground := False;
  InstallCard.Color := clWhite;

  InstallRail := TPanel.Create(WizardForm);
  InstallRail.Parent := WizardForm;
  InstallRail.SetBounds(0, 0, ScaleX(180), InstallCard.ClientHeight);
  InstallRail.BevelOuter := bvNone;
  InstallRail.ParentBackground := False;
  InstallRail.Color := $00F7FAFB;

  InstallRailBackground := TBitmapImage.Create(WizardForm);
  InstallRailBackground.Parent := InstallRail;
  InstallRailBackground.SetBounds(0, 0, InstallRail.ClientWidth, InstallRail.ClientHeight);
  InstallRailBackground.Stretch := True;
  InstallRailBackground.Align := alClient;
  InstallRailBackground.Bitmap.LoadFromFile(ExpandConstant('{tmp}\ngt-studio-installer-rail.bmp'));

  InstallBrandImage := TBitmapImage.Create(WizardForm);
  InstallBrandImage.Parent := InstallRail;
  InstallBrandImage.SetBounds(ScaleX(35), ScaleY(26), ScaleX(48), ScaleY(48));
  InstallBrandImage.Stretch := True;
  InstallBrandImage.Bitmap.LoadFromFile(ExpandConstant('{tmp}\ngt-studio-installer.bmp'));

  InstallBrandLabel := TNewStaticText.Create(WizardForm);
  InstallBrandLabel.Parent := InstallRail;
  InstallBrandLabel.SetBounds(ScaleX(28), ScaleY(82), ScaleX(130), ScaleY(28));
  InstallBrandLabel.Caption := 'NGTManager';
  InstallBrandLabel.Font.Name := 'Segoe UI';
  InstallBrandLabel.Font.Size := 14;
  InstallBrandLabel.Font.Style := [fsBold];
  InstallBrandLabel.Font.Color := $001F2729;

  InstallVersionLabel := TNewStaticText.Create(WizardForm);
  InstallVersionLabel.Parent := InstallRail;
  InstallVersionLabel.SetBounds(ScaleX(30), ScaleY(112), ScaleX(82), ScaleY(22));
  InstallVersionLabel.Caption := 'v{#AppVersion}';
  InstallVersionLabel.Font.Name := 'Segoe UI';
  InstallVersionLabel.Font.Size := 9;
  InstallVersionLabel.Font.Color := $00576D70;
  VersionCapsule := TPanel.Create(WizardForm);
  VersionCapsule.Parent := InstallRail;
  VersionCapsule.SetBounds(ScaleX(16), ScaleY(112), ScaleX(64), ScaleY(22));
  VersionCapsule.BevelOuter := bvNone;
  VersionCapsule.ParentBackground := False;
  VersionCapsule.Color := $00DFF0FC;
  ApplyRoundedCard(VersionCapsule);
  InstallVersionLabel.Parent := VersionCapsule;
  InstallVersionLabel.SetBounds(ScaleX(8), ScaleY(3), ScaleX(52), ScaleY(18));
  InstallVersionLabel.Color := VersionCapsule.Color;

  InstallEyebrowLabel := TNewStaticText.Create(WizardForm);
  InstallEyebrowLabel.Parent := InstallCard;
  InstallEyebrowLabel.SetBounds(ScaleX(208), ScaleY(22), ContentWidth - ScaleX(52), ScaleY(18));
  InstallEyebrowLabel.Caption := UiText('安装', 'INSTALLAZIONE', 'INSTALLATION');
  InstallEyebrowLabel.Font.Name := 'Segoe UI';
  InstallEyebrowLabel.Font.Size := 9;
  InstallEyebrowLabel.Font.Style := [fsBold];
  InstallEyebrowLabel.Font.Color := $0000789A;

  InstallStageIconPanel := TPanel.Create(WizardForm);
  InstallStageIconPanel.Parent := InstallCard;
  InstallStageIconPanel.SetBounds(ScaleX(208), ScaleY(48), ScaleX(44), ScaleY(44));
  InstallStageIconPanel.BevelOuter := bvNone;
  InstallStageIconPanel.ParentBackground := False;
  InstallStageIconPanel.Color := clWhite;
  ApplyRoundedCard(InstallStageIconPanel);

  InstallStageIconLabel := TNewStaticText.Create(WizardForm);
  InstallStageIconLabel.Parent := InstallStageIconPanel;
  InstallStageIconLabel.Visible := False;
  InstallStageImage := TBitmapImage.Create(WizardForm);
  InstallStageImage.Parent := InstallStageIconPanel;
  InstallStageImage.SetBounds(0, 0, InstallStageIconPanel.ClientWidth, InstallStageIconPanel.ClientHeight);
  InstallStageImage.Stretch := True;
  InstallStageImage.Bitmap.LoadFromFile(ExpandConstant('{tmp}\ngt-stage-package.bmp'));
  InstallStageIconLabel.SetBounds(0, ScaleY(7), InstallStageIconPanel.ClientWidth, ScaleY(28));
  InstallStageIconLabel.Alignment := taCenter;
  InstallStageIconLabel.Font.Name := 'Segoe UI Symbol';
  InstallStageIconLabel.Font.Size := 15;
  InstallStageIconLabel.Font.Color := $00D4852B;

  WizardForm.StatusLabel.Parent := InstallCard;
  WizardForm.StatusLabel.SetBounds(ScaleX(264), ScaleY(48), ContentWidth - ScaleX(108), ScaleY(30));
  WizardForm.StatusLabel.Font.Name := 'Segoe UI';
  WizardForm.StatusLabel.Font.Size := 14;
  WizardForm.StatusLabel.Font.Style := [fsBold];
  WizardForm.StatusLabel.Font.Color := $001F2729;
  WizardForm.StatusLabel.AutoSize := False;
  WizardForm.StatusLabel.WordWrap := True;

  InstallDescriptionLabel := TNewStaticText.Create(WizardForm);
  InstallDescriptionLabel.Parent := InstallCard;
  InstallDescriptionLabel.SetBounds(ScaleX(264), ScaleY(78), ContentWidth - ScaleX(108), ScaleY(22));
  InstallDescriptionLabel.Caption := UiText('正在准备安装所需文件。',
    'Preparazione dei file necessari per l''installazione.',
    'Preparing the files required for installation.');
  InstallDescriptionLabel.Font.Name := 'Segoe UI';
  InstallDescriptionLabel.Font.Size := 10;
  InstallDescriptionLabel.Font.Color := $00576D70;

  InstallWarningLabel := TNewStaticText.Create(WizardForm);
  InstallWarningLabel.Parent := InstallCard;
  InstallWarningLabel.SetBounds(ScaleX(208), ScaleY(102), ContentWidth - ScaleX(52), ScaleY(20));
  InstallWarningLabel.Font.Name := 'Segoe UI';
  InstallWarningLabel.Font.Size := 9;
  InstallWarningLabel.Font.Color := $00004FBA;
  InstallWarningLabel.Visible := False;

  WizardForm.FilenameLabel.Visible := False;

  FailureDetails := TNewMemo.Create(WizardForm);
  FailureDetails.Parent := InstallCard;
  FailureDetails.SetBounds(ScaleX(208), ScaleY(78), ContentWidth - ScaleX(52), ScaleY(118));
  FailureDetails.ReadOnly := True;
  FailureDetails.ScrollBars := ssVertical;
  FailureDetails.Color := clWhite;
  FailureDetails.Font.Name := 'Segoe UI';
  FailureDetails.Font.Size := 9;
  FailureDetails.Font.Color := $00576D70;
  FailureDetails.Visible := False;

  WizardForm.ProgressGauge.Visible := False;
  BrandProgressTrack := TPanel.Create(WizardForm);
  BrandProgressTrack.Parent := InstallCard;
  BrandProgressTrack.SetBounds(ScaleX(208), ScaleY(128),
    ContentWidth - ScaleX(52), ScaleY(8));
  BrandProgressTrack.BevelOuter := bvNone;
  BrandProgressTrack.ParentBackground := False;
  BrandProgressTrack.Color := $00E9E7E1;
  BrandProgressFill := TPanel.Create(WizardForm);
  BrandProgressFill.Parent := BrandProgressTrack;
  BrandProgressFill.SetBounds(0, 0, ScaleX(96), BrandProgressTrack.ClientHeight);
  BrandProgressFill.BevelOuter := bvNone;
  BrandProgressFill.ParentBackground := False;
  BrandProgressFill.Color := $002DC6F4;
  SetBrandProgressActive;

  InstallMetrics := TPanel.Create(WizardForm);
  InstallMetrics.Parent := InstallCard;
  InstallMetrics.SetBounds(ScaleX(208), ScaleY(150),
    ContentWidth - ScaleX(52), ScaleY(58));
  InstallMetrics.BevelOuter := bvNone;
  SetWindowLong(InstallMetrics.Handle, -20, GetWindowLong(InstallMetrics.Handle, -20) or $02000000);
  InstallMetrics.ParentBackground := False;
  InstallMetrics.Color := $00EAF6FB;
  ApplyRoundedCard(InstallMetrics);
  MetricSurface := TPanel.Create(WizardForm);
  MetricSurface.Parent := InstallMetrics;
  MetricSurface.ParentBackground := False;
  MetricSurface.BevelOuter := bvNone;
  MetricSurface.Color := InstallMetrics.Color;
  InstallMetrics.Color := $00CEDFE9;
  for I := 0 to 2 do
  begin
    MetricIcons[I] := TBitmapImage.Create(WizardForm);
    MetricIcons[I].Parent := MetricSurface;
    MetricIcons[I].Stretch := True;
    if I = 0 then
      MetricIcons[I].Bitmap.LoadFromFile(ExpandConstant('{tmp}\ngt-metric-package.bmp'))
    else
      MetricIcons[I].Bitmap.LoadFromFile(ExpandConstant('{tmp}\ngt-metric-clock.bmp'));
  end;
  for I := 0 to 1 do
  begin
    MetricDividers[I] := TPanel.Create(WizardForm);
    MetricDividers[I].Parent := MetricSurface;
    MetricDividers[I].BevelOuter := bvNone;
    MetricDividers[I].ParentBackground := False;
    MetricDividers[I].Color := $00CEDFE9;
  end;

  InstallFilesLabel := TNewStaticText.Create(WizardForm);
  InstallFilesLabel.Parent := MetricSurface;
  InstallFilesLabel.SetBounds(ScaleX(18), ScaleY(9), ScaleX(135), ScaleY(42));
  InstallFilesLabel.Font.Name := 'Segoe UI';
  InstallFilesLabel.Font.Size := 9;
  InstallFilesLabel.Font.Color := $00576D70;
  InstallFilesLabel.Caption := UiText('已处理文件', 'File elaborati', 'Files processed');
  InstallFilesLabel.Color := MetricSurface.Color;

  InstallFilesValue := TNewStaticText.Create(WizardForm);
  InstallFilesValue.Parent := MetricSurface;
  InstallFilesValue.SetBounds(ScaleX(18), ScaleY(26), ScaleX(135), ScaleY(25));
  InstallFilesValue.Caption := '0';
  InstallFilesValue.Font.Name := 'Segoe UI';
  InstallFilesValue.Font.Size := 13;
  InstallFilesValue.Font.Style := [fsBold];
  InstallFilesValue.Font.Color := $001F2729;
  InstallFilesValue.Color := MetricSurface.Color;

  InstallTotalLabel := TNewStaticText.Create(WizardForm);
  InstallTotalLabel.Parent := MetricSurface;
  InstallTotalLabel.SetBounds(ScaleX(170), ScaleY(9), ScaleX(135), ScaleY(42));
  InstallTotalLabel.Font.Name := 'Segoe UI';
  InstallTotalLabel.Font.Size := 9;
  InstallTotalLabel.Font.Color := $00576D70;
  InstallTotalLabel.Caption := UiText('总耗时', 'Tempo totale', 'Total time');
  InstallTotalLabel.Color := MetricSurface.Color;

  InstallTotalValue := TNewStaticText.Create(WizardForm);
  InstallTotalValue.Parent := MetricSurface;
  InstallTotalValue.SetBounds(ScaleX(170), ScaleY(26), ScaleX(135), ScaleY(25));
  InstallTotalValue.Caption := '00:00';
  InstallTotalValue.Font.Name := 'Segoe UI';
  InstallTotalValue.Font.Size := 13;
  InstallTotalValue.Font.Style := [fsBold];
  InstallTotalValue.Font.Color := $001F2729;
  InstallTotalValue.Color := MetricSurface.Color;

  InstallPhaseLabel := TNewStaticText.Create(WizardForm);
  InstallPhaseLabel.Parent := MetricSurface;
  InstallPhaseLabel.SetBounds(ScaleX(322), ScaleY(9), ScaleX(135), ScaleY(42));
  InstallPhaseLabel.Font.Name := 'Segoe UI';
  InstallPhaseLabel.Font.Size := 9;
  InstallPhaseLabel.Font.Color := $00576D70;
  InstallPhaseLabel.Caption := UiText('当前阶段', 'Fase corrente', 'Current phase');
  InstallPhaseLabel.Color := MetricSurface.Color;

  InstallPhaseValue := TNewStaticText.Create(WizardForm);
  InstallPhaseValue.Parent := MetricSurface;
  InstallPhaseValue.SetBounds(ScaleX(322), ScaleY(26), ScaleX(135), ScaleY(25));
  InstallPhaseValue.Caption := '00:00';
  InstallPhaseValue.Font.Name := 'Segoe UI';
  InstallPhaseValue.Font.Size := 13;
  InstallPhaseValue.Font.Style := [fsBold];
  InstallPhaseValue.Font.Color := $001F2729;
  InstallPhaseValue.Color := MetricSurface.Color;

  FinishCard := TPanel.Create(WizardForm);
  FinishCard.Parent := WizardForm.FinishedPage;
  FinishCard.SetBounds(0, 0, WizardForm.FinishedPage.ClientWidth,
    WizardForm.FinishedPage.ClientHeight);
  FinishCard.BevelOuter := bvNone;
  FinishCard.ParentBackground := False;
  FinishCard.Color := clWhite;

  FinishRail := TPanel.Create(WizardForm);
  FinishRail.Parent := WizardForm;
  FinishRail.SetBounds(0, 0, ScaleX(180), FinishCard.ClientHeight);
  FinishRail.BevelOuter := bvNone;
  FinishRail.ParentBackground := False;
  FinishRail.Color := $00F7FAFB;

  FinishRailBackground := TBitmapImage.Create(WizardForm);
  FinishRailBackground.Parent := FinishRail;
  FinishRailBackground.SetBounds(0, 0, FinishRail.ClientWidth, FinishRail.ClientHeight);
  FinishRailBackground.Stretch := True;
  FinishRailBackground.Align := alClient;
  FinishRailBackground.Bitmap.Assign(InstallRailBackground.Bitmap);

  FinishBrandImage := TBitmapImage.Create(WizardForm);
  FinishBrandImage.Parent := FinishRail;
  FinishBrandImage.SetBounds(ScaleX(35), ScaleY(26), ScaleX(48), ScaleY(48));
  FinishBrandImage.Stretch := True;
  FinishBrandImage.Bitmap.Assign(InstallBrandImage.Bitmap);

  FinishBrandLabel := TNewStaticText.Create(WizardForm);
  FinishBrandLabel.Parent := FinishRail;
  FinishBrandLabel.SetBounds(ScaleX(28), ScaleY(82), ScaleX(130), ScaleY(28));
  FinishBrandLabel.Caption := 'NGTManager';
  FinishBrandLabel.Font.Name := 'Segoe UI';
  FinishBrandLabel.Font.Size := 14;
  FinishBrandLabel.Font.Style := [fsBold];
  FinishBrandLabel.Font.Color := $001F2729;

  FinishVersionLabel := TNewStaticText.Create(WizardForm);
  FinishVersionLabel.Parent := FinishRail;
  FinishVersionLabel.SetBounds(ScaleX(30), ScaleY(112), ScaleX(82), ScaleY(22));
  FinishVersionLabel.Caption := 'v{#AppVersion}';
  FinishVersionLabel.Font.Name := 'Segoe UI';
  FinishVersionLabel.Font.Size := 9;
  FinishVersionLabel.Font.Color := $00576D70;
  VersionCapsule := TPanel.Create(WizardForm);
  VersionCapsule.Parent := FinishRail;
  VersionCapsule.SetBounds(ScaleX(16), ScaleY(112), ScaleX(64), ScaleY(22));
  VersionCapsule.BevelOuter := bvNone;
  VersionCapsule.ParentBackground := False;
  VersionCapsule.Color := $00DFF0FC;
  ApplyRoundedCard(VersionCapsule);
  FinishVersionLabel.Parent := VersionCapsule;
  FinishVersionLabel.SetBounds(ScaleX(8), ScaleY(3), ScaleX(52), ScaleY(18));
  FinishVersionLabel.Color := VersionCapsule.Color;
  FinishStage := TBitmapImage.Create(WizardForm);
  FinishStage.Parent := FinishCard;
  FinishStage.SetBounds(ScaleX(208), ScaleY(42), ScaleX(48), ScaleY(48));
  FinishStage.Stretch := True;
  FinishStage.Bitmap.LoadFromFile(ExpandConstant('{tmp}\ngt-stage-success.bmp'));

  WizardForm.FinishedHeadingLabel.Parent := FinishCard;
  WizardForm.FinishedHeadingLabel.SetBounds(ScaleX(208), ScaleY(42), ContentWidth - ScaleX(52), ScaleY(34));
  WizardForm.FinishedHeadingLabel.Font.Name := 'Segoe UI';
  WizardForm.FinishedHeadingLabel.Font.Size := 14;
  WizardForm.FinishedHeadingLabel.Font.Style := [fsBold];
  WizardForm.FinishedHeadingLabel.Font.Color := $001F2729;
  WizardForm.FinishedLabel.Parent := FinishCard;
  WizardForm.FinishedLabel.SetBounds(ScaleX(208), ScaleY(78), ContentWidth - ScaleX(52), ScaleY(44));
  WizardForm.FinishedLabel.Font.Name := 'Segoe UI';
  WizardForm.FinishedLabel.Font.Size := 10;
  WizardForm.FinishedLabel.Font.Color := $00576D70;
  FinishInfo := TPanel.Create(WizardForm);
  FinishInfo.Parent := FinishCard;
  FinishInfo.SetBounds(ScaleX(208), ScaleY(132), ContentWidth - ScaleX(52), ScaleY(58));
  FinishInfo.BevelOuter := bvNone;
  FinishInfo.ParentBackground := False;
  FinishInfo.Color := $00EAF6FB;
  ApplyRoundedCard(FinishInfo);

  WizardForm.RunList.Parent := FinishInfo;
  WizardForm.RunList.Color := FinishInfo.Color;
  WizardForm.RunList.SetBounds(ScaleX(16), ScaleY(14), ContentWidth - ScaleX(84), ScaleY(34));
  CompactSummary := TNewMemo.Create(WizardForm);
  CompactSummary.Parent := MetricSurface; CompactSummary.ReadOnly := True; CompactSummary.ScrollBars := ssVertical; CompactSummary.BorderStyle := bsNone; CompactSummary.Color := MetricSurface.Color; CompactSummary.Font.Name := 'Segoe UI'; CompactSummary.Font.Size := 9;
  FinishDetails := TNewMemo.Create(WizardForm);
  FinishDetails.Parent := FinishCard; FinishDetails.ReadOnly := True; FinishDetails.ScrollBars := ssVertical; FinishDetails.BorderStyle := bsNone; FinishDetails.Color := FinishCard.Color; FinishDetails.Font.Name := 'Segoe UI'; FinishDetails.Font.Size := 9;
  ReadyCard := TPanel.Create(WizardForm);
  ReadyCard.Parent := WizardForm.ReadyPage;
  ReadyCard.SetBounds(0, 0, WizardForm.ReadyPage.ClientWidth, WizardForm.ReadyPage.ClientHeight);
  ReadyCard.BevelOuter := bvNone;
  ReadyCard.ParentBackground := False;
  ReadyCard.Color := clWhite;
  ReadyRail := TPanel.Create(WizardForm);
  ReadyRail.Parent := WizardForm;
  ReadyRail.SetBounds(0, 0, ScaleX(180), ReadyCard.Height);
  ReadyRail.BevelOuter := bvNone;
  ReadyRail.ParentBackground := False;
  ReadyRail.Color := $00F7FAFB;
  ReadyBackground := TBitmapImage.Create(WizardForm);
  ReadyBackground.Parent := ReadyRail;
  ReadyBackground.SetBounds(0, 0, ReadyRail.Width, ReadyRail.Height);
  ReadyBackground.Stretch := True;
  ReadyBackground.Align := alClient;
  ReadyBackground.Bitmap.Assign(InstallRailBackground.Bitmap);
  ReadyBrand := TBitmapImage.Create(WizardForm);
  ReadyBrand.Parent := ReadyRail;
  ReadyBrand.SetBounds(ScaleX(35), ScaleY(26), ScaleX(48), ScaleY(48));
  ReadyBrand.Stretch := True;
  ReadyBrand.Bitmap.Assign(InstallBrandImage.Bitmap);
  ReadyProduct := TNewStaticText.Create(WizardForm);
  ReadyProduct.Parent := ReadyRail;
  ReadyProduct.SetBounds(ScaleX(28), ScaleY(82), ScaleX(140), ScaleY(28));
  ReadyProduct.Caption := 'NGTManager';
  ReadyProduct.Font.Name := 'Segoe UI';
  ReadyProduct.Font.Size := 14;
  ReadyProduct.Font.Style := [fsBold];
  ReadyProduct.Font.Color := $001F2729;
  ReadyProduct.Color := ReadyRail.Color;
  ReadyVersion := TNewStaticText.Create(WizardForm);
  ReadyVersion.Parent := ReadyRail;
  ReadyVersion.SetBounds(ScaleX(28), ScaleY(112), ScaleX(100), ScaleY(22));
  ReadyVersion.Caption := 'v{#AppVersion}';
  ReadyVersion.Font.Color := $00576D70;
  ReadyVersion.Color := ReadyRail.Color;
  ReadyStage := TBitmapImage.Create(WizardForm);
  ReadyStage.Parent := ReadyCard;
  ReadyStage.SetBounds(ScaleX(208), ScaleY(48), ScaleX(48), ScaleY(48));
  ReadyStage.Stretch := True;
  ReadyStage.Bitmap.LoadFromFile(ExpandConstant('{tmp}\ngt-stage-shield.bmp'));
  ReadyEyebrow := TNewStaticText.Create(WizardForm);
  ReadyEyebrow.Parent := ReadyCard;
  ReadyEyebrow.SetBounds(ScaleX(208), ScaleY(22), ScaleX(420), ScaleY(18));
  ReadyEyebrow.Caption := UiText('安装', 'INSTALLAZIONE', 'INSTALLATION');
  ReadyEyebrow.Font.Name := 'Segoe UI';
  ReadyEyebrow.Font.Size := 9;
  ReadyEyebrow.Font.Style := [fsBold];
  ReadyEyebrow.Font.Color := $0000789A;
  ReadyHeading := TNewStaticText.Create(WizardForm);
  ReadyHeading.Parent := ReadyCard;
  ReadyHeading.SetBounds(ScaleX(272), ScaleY(48), ScaleX(420), ScaleY(34));
  ReadyHeading.Caption := UiText('准备安装 NGTManager', 'Pronto per installare NGTManager', 'Ready to install NGTManager');
  ReadyHeading.Font.Name := 'Segoe UI';
  ReadyHeading.Font.Size := 14;
  ReadyHeading.Font.Style := [fsBold];
  ReadyHeading.Font.Color := $001F2729;
  ReadyHeading.AutoSize := False;
  ReadyHeading.WordWrap := True;
  ReadyDescription := TNewStaticText.Create(WizardForm);
  ReadyDescription.Parent := ReadyCard;
  ReadyDescription.SetBounds(ScaleX(272), ScaleY(94), ScaleX(420), ScaleY(82));
  ReadyDescription.WordWrap := True;
  ReadyDescription.AutoSize := False;
  ReadyDescription.Font.Name := 'Segoe UI';
  ReadyDescription.Font.Size := 10;
  ReadyDescription.Font.Color := $00576D70;
  ReadyDescription.Caption := UiText('点击“安装”继续。现有业务数据和备份将保留。',
    'Fai clic su Installa per continuare. I dati e i backup esistenti verranno conservati.',
    'Click Install to continue. Existing business data and backups will be preserved.');
  WizardForm.ReadyMemo.Visible := False;
  WizardForm.ReadyLabel.Visible := False;
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

function CreateLanguageDialog: TSetupForm;
var
  Form: TSetupForm;
  Rail, Footer, Capsule: TPanel;
  Logo, Decoration: TBitmapImage;
  Title, Description, Version, Eyebrow: TNewStaticText;
  LeftEdge: Integer;
  Compact: Boolean;
begin
  ExtractTemporaryFile('ngt-studio-installer.bmp');
  ExtractTemporaryFile('ngt-studio-installer-white.bmp');
  ExtractTemporaryFile('ngt-studio-installer-rail.bmp');
  Form := CreateCustomForm(480, 220, True, True);
  Form.Width := ScaleX(480); Form.Height := ScaleY(220);
  Form.Caption := 'NGTManager'; Form.Color := clWhite;
  Form.Font.Name := 'Segoe UI'; Form.Font.Size := 10;
  Form.BorderIcons := [biSystemMenu];
  FitDesktopWindow(Form.Handle);
  Compact := Form.ClientWidth < ScaleX(440);
  LeftEdge := ScaleX(156);
  if Compact then LeftEdge := ScaleX(16);
  Rail := TPanel.Create(Form); Rail.Parent := Form;
  Rail.SetBounds(0, 0, ScaleX(136), Form.ClientHeight);
  Rail.BevelOuter := bvNone; Rail.ParentBackground := False; Rail.Color := $00F7FAFB;
  Rail.Anchors := [akLeft, akTop, akBottom]; Rail.Visible := not Compact;
  Decoration := TBitmapImage.Create(Form); Decoration.Parent := Rail;
  Decoration.SetBounds(0, 0, Rail.Width, Rail.Height); Decoration.Align := alClient; Decoration.Stretch := True;
  Decoration.Bitmap.LoadFromFile(ExpandConstant('{tmp}\ngt-studio-installer-rail.bmp'));
  Logo := TBitmapImage.Create(Form); Logo.Parent := Rail;
  Logo.SetBounds(ScaleX(20), ScaleY(20), ScaleX(40), ScaleY(40)); Logo.Stretch := True;
  Logo.Bitmap.LoadFromFile(ExpandConstant('{tmp}\ngt-studio-installer.bmp'));
  Title := TNewStaticText.Create(Form); Title.Parent := Rail;
  Title.SetBounds(ScaleX(12), ScaleY(72), ScaleX(120), ScaleY(24)); Title.Caption := 'NGTManager';
  Title.Font.Size := 14; Title.Font.Style := [fsBold]; Title.Font.Color := $001F2729;
  Capsule := TPanel.Create(Form); Capsule.Parent := Rail;
  Capsule.SetBounds(ScaleX(12), ScaleY(102), ScaleX(64), ScaleY(22));
  Capsule.BevelOuter := bvNone; Capsule.ParentBackground := False; Capsule.Color := $00EAF6FB;
  ApplyRoundedCard(Capsule);
  Version := TNewStaticText.Create(Form); Version.Parent := Capsule;
  Version.SetBounds(ScaleX(8), ScaleY(2), ScaleX(54), ScaleY(18)); Version.Caption := 'v{#AppVersion}';
  Version.Font.Size := 9; Version.Font.Color := $00576D70;
  Eyebrow := TNewStaticText.Create(Form); Eyebrow.Parent := Form;
  Eyebrow.SetBounds(LeftEdge, ScaleY(16), Form.ClientWidth - LeftEdge - ScaleX(16), ScaleY(18));
  Eyebrow.Caption := UiText('安装', 'INSTALLAZIONE', 'INSTALLATION');
  Eyebrow.Font.Size := 9; Eyebrow.Font.Style := [fsBold]; Eyebrow.Font.Color := $0000789D;
  Description := TNewStaticText.Create(Form); Description.Parent := Form;
  Description.SetBounds(LeftEdge, ScaleY(42), Form.ClientWidth - LeftEdge - ScaleX(16), ScaleY(48));
  Description.Anchors := [akLeft, akTop, akRight];
  Description.Caption := UiText('选择安装语言', 'Scegli la lingua di installazione', 'Choose your installation language');
  Description.Font.Size := 13; Description.Font.Style := [fsBold]; Description.Font.Color := $001F2729;
  LanguageChoice := TNewComboBox.Create(Form); LanguageChoice.Parent := Form;
  LanguageChoice.Style := csDropDownList; LanguageChoice.Color := $00F7FAFB;
  LanguageChoice.SetBounds(LeftEdge, ScaleY(96), Form.ClientWidth - LeftEdge - ScaleX(16), ScaleY(26));
  LanguageChoice.Anchors := [akLeft, akTop, akRight];
  LanguageChoice.Items.Add('简体中文'); LanguageChoice.Items.Add('Italiano'); LanguageChoice.Items.Add('English');
  LanguageChoice.ItemIndex := 2;
  if ActiveLanguage = 'chinesesimplified' then LanguageChoice.ItemIndex := 0;
  if ActiveLanguage = 'italian' then LanguageChoice.ItemIndex := 1;
  Footer := TPanel.Create(Form); Footer.Parent := Form;
  Footer.SetBounds(LeftEdge - ScaleX(20), Form.ClientHeight - ScaleY(48), Form.ClientWidth - LeftEdge + ScaleX(20), ScaleY(1));
  if Compact then Footer.Left := 0;
  Footer.Anchors := [akLeft, akRight, akBottom]; Footer.BevelOuter := bvNone; Footer.Color := $00E4E9EC;
  LanguageCancel := TNewButton.Create(Form); LanguageCancel.Parent := Form;
  LanguageCancel.SetBounds(Form.ClientWidth - ScaleX(116), Form.ClientHeight - ScaleY(39), ScaleX(100), ScaleY(30));
  LanguageCancel.Anchors := [akRight, akBottom];
  LanguageCancel.Caption := UiText('取消', 'Annulla', 'Cancel'); LanguageCancel.Cancel := True; LanguageCancel.ModalResult := mrCancel;
  LanguageAccept := TNewButton.Create(Form); LanguageAccept.Parent := Form;
  LanguageAccept.SetBounds(LanguageCancel.Left - ScaleX(108), LanguageCancel.Top, ScaleX(100), ScaleY(30));
  LanguageAccept.Anchors := [akRight, akBottom];
  LanguageAccept.Caption := UiText('继续', 'Continua', 'Continue'); LanguageAccept.Default := True; LanguageAccept.ModalResult := mrOk;
  LanguageDialogHandle := Form.Handle;
  OriginalLanguageProc := SetWindowLong(Form.Handle, -4, CreateCallback(@BrandButtonWindowProc));
  if HighContrastActive then
  begin
    Form.Color := clWindow; Rail.Color := clWindow; Decoration.Visible := False;
    Capsule.Color := clWindow; LanguageChoice.Color := clWindow;
    Title.Font.Color := clWindowText; Version.Font.Color := clWindowText;
    Eyebrow.Font.Color := clWindowText; Description.Font.Color := clWindowText;
  end
  else
  begin
    UseBrandButton(LanguageAccept); UseBrandButton(LanguageCancel);
  end;
  Result := Form;
end;

function InitializeSetup: Boolean;
var
  Form: TSetupForm;
  SelectedLanguage, Arguments, Argument: String;
  I, ResultCode: Integer;
begin
  Result := True;
  if WizardSilent or (ExpandConstant('{param:NGTLanguageSelected|0}') = '1') then Exit;
  for I := 1 to ParamCount do
    if Pos('/lang=', Lowercase(ParamStr(I))) = 1 then Exit;
  Form := CreateLanguageDialog;
  try
    if Form.ShowModal <> mrOk then
    begin
      Result := False;
      Exit;
    end;
    case LanguageChoice.ItemIndex of
      0: SelectedLanguage := 'chinesesimplified';
      1: SelectedLanguage := 'italian';
    else
      SelectedLanguage := 'english';
    end;
  finally
    if OriginalLanguageProc <> 0 then
    begin
      SetWindowLong(Form.Handle, -4, OriginalLanguageProc);
      OriginalLanguageProc := 0;
      LanguageDialogHandle := 0;
    end;
    Form.Free;
  end;
  if SelectedLanguage <> ActiveLanguage then
  begin
    Arguments := '';
    for I := 1 to ParamCount do
    begin
      Argument := ParamStr(I);
      if (Pos('/lang=', Lowercase(Argument)) <> 1) and
        (Pos('/ngtlanguageselected=', Lowercase(Argument)) <> 1) then
        Arguments := Arguments + ' ' + AddQuotes(Argument);
    end;
    if not Exec(ExpandConstant('{srcexe}'), Arguments + ' /LANG=' + SelectedLanguage +
      ' /NGTLanguageSelected=1', '', SW_SHOWNORMAL, ewNoWait, ResultCode) then
      MsgBox(UiText('无法切换安装语言，请重新打开安装器。',
        'Impossibile cambiare lingua. Riapri il programma di installazione.',
        'Unable to switch language. Please reopen the installer.'), mbError, MB_OK);
    Result := False;
  end;
end;

procedure InitializeWizard;
var
  UpdateId: String;
begin
  ExtractTemporaryFile('ngt-studio-installer.bmp');
  ExtractTemporaryFile('ngt-studio-installer-rail.bmp');
  ExtractTemporaryFile('ngt-studio-installer-white.bmp');
  ExtractTemporaryFile('ngt-stage-package.bmp');
  ExtractTemporaryFile('ngt-stage-shield.bmp');
  ExtractTemporaryFile('ngt-stage-clock.bmp');
  ExtractTemporaryFile('ngt-stage-success.bmp');
  ExtractTemporaryFile('ngt-stage-error.bmp');
  ExtractTemporaryFile('ngt-metric-package.bmp');
  ExtractTemporaryFile('ngt-metric-clock.bmp');
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
  ActiveBrandPage := wpReady;
  DesktopLayoutReady := True;
  WizardForm.OnResize := @LayoutDesktopWizard;
  LayoutDesktopWizard(WizardForm);
  OriginalWizardProc := SetWindowLong(WizardForm.Handle, -4, CreateCallback(@BrandButtonWindowProc));
  if not HighContrastActive then
  begin
    UseBrandButton(WizardForm.NextButton);
    UseBrandButton(WizardForm.CancelButton);
  end;
#ifdef DesktopUiTest
  RunDesktopUiSelfTests;
#endif
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

procedure UpdateStageIcon(const Phase: String);
var
  IconName: String;
begin
  IconName := 'package';
  if Phase = 'complete' then IconName := 'success'
  else if (Phase = 'failed') or (Phase = 'recovery_failed') then IconName := 'error'
  else if (Phase = 'package_source_verification') or
    (Phase = 'source_copy_verification') or (Phase = 'candidate_verification') then IconName := 'shield';
  if InstallWarningActive and (IconName <> 'success') and (IconName <> 'error') then IconName := 'clock';
  if CurrentStageIcon = IconName then Exit;
  InstallStageImage.Bitmap.LoadFromFile(ExpandConstant('{tmp}\ngt-stage-' + IconName + '.bmp'));
  CurrentStageIcon := IconName;
#ifdef DesktopUiTest
  StageIconLoads := StageIconLoads + 1;
#endif
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
  MetricsVisible: Boolean;
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
  if CurrentPhase <> Phase then
  begin
    BrandProgressDeterminate := False;
    BrandProgressPosition := 0;
    BrandProgressAnimationTick := GetTickCount64;
    SendMessage(CompactSummary.Handle, $00B6, 0, -SendMessage(CompactSummary.Handle, $00CE, 0, 0));
  end;
  CurrentPhase := Phase;
  PhaseElapsedSeconds := StrToIntDef(PhaseElapsed, 0);
  TotalElapsedSeconds := StrToIntDef(TotalElapsed, 0);
  StatusText := PhaseDescription(Phase);
  InstallWarningActive := PhaseElapsedSeconds > 30;
  InstallWarningLabel.Caption := UiText(
      'ⓘ 此阶段所需时间比预计更长，操作仍在继续。',
      'ⓘ Questa fase sta richiedendo più tempo del previsto.',
      'ⓘ This phase is taking longer than expected.');
  if (CancelPending = '1') then
    InstallWarningLabel.Caption := UiText(
      'ⓘ 正在等待安全停止点，随后将自动回滚。',
      'ⓘ In attesa del prossimo punto sicuro prima del ripristino.',
      'ⓘ Waiting for a safe stop point before rolling back.');
  if (CancelPending = '2') then
    InstallWarningLabel.Caption := UiText(
      'ⓘ 当前阶段已无法取消，正在安全完成操作。',
      'ⓘ È troppo tardi per annullare; completamento sicuro in corso.',
      'ⓘ It is too late to cancel; finishing safely.');
  if CancelPending <> '0' then InstallWarningActive := True;
  UpdateStageIcon(Phase);
  WizardForm.StatusLabel.Caption := StatusText;
  InstallDescriptionLabel.Caption := UiText(
    '正在安全处理安装文件，请勿关闭电脑。',
    'Operazione sicura sui file di installazione in corso.',
    'Safely processing the installation files.');
  MetricsVisible := InstallMetrics.Visible;
  if MetricsVisible then SendMessage(InstallMetrics.Handle, $000B, 0, 0);
  try
    if StrToIntDef(ProcessedFiles, -1) >= 0 then
      InstallFilesValue.Caption := ProcessedFiles
    else
      InstallFilesValue.Caption := '—';
    InstallTotalValue.Caption := ElapsedText(TotalElapsedSeconds);
    InstallPhaseValue.Caption := ElapsedText(PhaseElapsedSeconds);
    UpdateCompactDetails;
  finally
    if MetricsVisible then
    begin
      SendMessage(InstallMetrics.Handle, $000B, 1, 0);
      RedrawWindow(InstallMetrics.Handle, 0, 0, $0081);
    end;
  end;
  InstallWarningLabel.Visible := InstallWarningActive and (not CompactDesktopLayout) and (not FailureDetails.Visible);
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
  UpdateStageIcon(CurrentPhase);
  WizardForm.StatusLabel.Caption := PhaseDescription(CurrentPhase);
  InstallDescriptionLabel.Caption := UiText('正在准备安装所需文件。',
    'Preparazione dei file necessari per l''installazione.',
    'Preparing the files required for installation.');
  InstallWarningLabel.Visible := False;
  InstallFilesValue.Caption := '—';
  InstallTotalValue.Caption := '00:00';
  InstallPhaseValue.Caption := '00:00';
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
    UpdateStageIcon('failed');
    InstallDescriptionLabel.Visible := False;
    InstallWarningLabel.Visible := False; InstallWarningActive := False;
    BrandProgressTrack.Visible := False;
    InstallMetrics.Visible := False;
    WizardForm.FilenameLabel.Visible := False;
    FailureDetails.Text := MessageText + #13#10 +
      UiText('操作编号：', 'Tentativo: ', 'Attempt ID: ') + AttemptId;
    FailureDetails.Visible := True;
    LayoutDesktopWizard(WizardForm);
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
  if OriginalWizardProc <> 0 then
  begin
    UseBrandButton(WizardForm.NextButton);
    UseBrandButton(WizardForm.CancelButton);
  end;
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
  ActiveBrandPage := CurPageID;
  if OriginalWizardProc <> 0 then
  begin
    UseBrandButton(WizardForm.NextButton);
    UseBrandButton(WizardForm.CancelButton);
  end;
  if not WizardForm.CancelButton.Visible then
    WizardForm.NextButton.Left := WizardForm.CancelButton.Left;
  WizardForm.MainPanel.Visible :=
    (CurPageID <> wpInstalling) and (CurPageID <> wpFinished) and (CurPageID <> wpReady);
  if CurPageID = wpReady then ReadyCard.BringToFront;
  if CurPageID = wpFinished then
  begin
    FinishCard.BringToFront;
    WizardForm.FinishedHeadingLabel.Caption := UiText(
      'NGTManager 已准备就绪',
      'NGTManager è pronto',
      'NGTManager is ready');
    WizardForm.FinishedLabel.Caption := UiText(
      '可通过桌面快捷方式打开 NGTManager；关闭业务窗口后，仍可从系统托盘重新打开或安全退出。',
      'Apri NGTManager dal collegamento sul desktop. Dopo aver chiuso la finestra, puoi riaprirlo o uscire in sicurezza dall''area di notifica.',
      'Open NGTManager from the desktop shortcut. After closing the application window, use the tray icon to reopen it or exit safely.');
  end;
  LayoutDesktopWizard(WizardForm);
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
        InstallDescriptionLabel.Caption := UiText(
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
        InstallDescriptionLabel.Caption := UiText(
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
  if OriginalWizardProc <> 0 then
  begin
    SetWindowLong(WizardForm.Handle, -4, OriginalWizardProc);
    OriginalWizardProc := 0;
  end;
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

#ifdef DesktopUiTest
#include "tests/desktop-ui-selftest.iss"
#endif
