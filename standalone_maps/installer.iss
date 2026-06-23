; Inno Setup script — установщик «Карты».
; Собирает dist\Karty.exe в установщик с выбором папки, ярлыками и автозапуском.
; Компиляция: build_installer.bat (или открыть в Inno Setup и нажать Compile).

#define AppName "Карты"
#define AppVer  "1.0"
#define ExeName "Karty.exe"

[Setup]
AppName={#AppName}
AppVersion={#AppVer}
AppPublisher=ЦСООР
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
OutputBaseFilename=Карты-Setup
OutputDir=Output
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; Установка в Program Files требует прав администратора (папку админ выбирает в мастере).
PrivilegesRequired=admin
UninstallDisplayIcon={app}\{#ExeName}
UninstallDisplayName={#AppName}

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"
Name: "autostart"; Description: "Запускать «Карты» при входе в Windows"; GroupDescription: "Дополнительно:"; Flags: unchecked

[Files]
Source: "dist\{#ExeName}"; DestDir: "{app}"; Flags: ignoreversion
; Ключ Яндекс.Карт — кладётся в папку установки, если есть рядом со сборкой.
Source: "yandex.key"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
Source: "README.md"; DestDir: "{app}"; Flags: ignoreversion isreadme skipifsourcedoesntexist

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#ExeName}"
Name: "{group}\Удалить {#AppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#ExeName}"; Tasks: desktopicon
Name: "{userstartup}\{#AppName}"; Filename: "{app}\{#ExeName}"; Tasks: autostart

[Run]
Filename: "{app}\{#ExeName}"; Description: "Запустить «Карты» сейчас"; Flags: nowait postinstall skipifsilent
