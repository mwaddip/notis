; Inno Setup script for the Notis testnet node (win-x64).
; Driven by build-bundle.ps1:
;   ISCC /DMyAppVersion=<ver> /DStageDir=<stage> /O<repo root> notis.iss
; Per-user install (no admin), three shortcuts.

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "stage"
#endif

[Setup]
AppName=Notis Node (testnet)
AppVersion={#MyAppVersion}
DefaultDirName={localappdata}\Notis
DefaultGroupName=Notis
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
OutputBaseFilename=notis-node-{#MyAppVersion}-win-x64-setup
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Notis Node";         Filename: "{app}\launch-node.cmd";  WorkingDir: "{app}"
Name: "{group}\Notis Node (Miner)"; Filename: "{app}\launch-miner.cmd"; WorkingDir: "{app}"
Name: "{group}\Notis Demo UI";      Filename: "{app}\open-ui.cmd";      WorkingDir: "{app}"
Name: "{userdesktop}\Notis Node";         Filename: "{app}\launch-node.cmd";  WorkingDir: "{app}"
Name: "{userdesktop}\Notis Node (Miner)"; Filename: "{app}\launch-miner.cmd"; WorkingDir: "{app}"
Name: "{userdesktop}\Notis Demo UI";      Filename: "{app}\open-ui.cmd";      WorkingDir: "{app}"
