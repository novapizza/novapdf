; Windows installer hooks (bundle.windows.nsis.installerHooks in tauri.conf.json).
;
; Product-name migration. The app has shipped as NovaPDF and as NovaQuire.
; Windows keys an install by its product name (the Apps & features entry and the
; install folder), so installing one name never upgrades the other: without this
; hook, an auto-update from NovaPDF to NovaQuire would leave both installed.
;
; After this installer has written its own files, it retires the install of the
; other name: deletes that install's program files, its Start menu and desktop
; shortcuts and its Apps & features entry, and points a taskbar pin at the new
; program and the user's "Open with" default at the new program. It deliberately
; keeps everything both names share: the app identifier
; (io.novapdf.app), its settings and WebView data, and the PDF file association.
; That is also why it does not run the other install's uninstaller, which would
; delete some of that shared state.
;
; Nothing of the other install is touched unless its program can be deleted
; first; if it is still locked, the other install stays as it is and the next
; update retries. The hook is symmetric, so a release under either name retires
; the other one: renaming forward and back are the same operation.

!define NOVA_UNINSTALL_ROOT "Software\Microsoft\Windows\CurrentVersion\Uninstall"
!define NOVA_TASKBAR_PINS "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"

; Retires the install of product NAME, unless NAME is this installer's own name.
; Uses $R4-$R9; the template's macros used here clobber $0-$3.
!macro NOVA_RETIRE_INSTALL NAME
  !if "${NAME}" != "${PRODUCTNAME}"
    ReadRegStr $R4 SHCTX "${NOVA_UNINSTALL_ROOT}\${NAME}" "InstallLocation"
    ReadRegStr $R5 SHCTX "${NOVA_UNINSTALL_ROOT}\${NAME}" "MainBinaryName"
    ; The template writes InstallLocation in quotes.
    StrCpy $R6 $R4 1
    ${If} $R6 == '"'
      StrCpy $R4 $R4 "" 1
      StrCpy $R4 $R4 -1
    ${EndIf}
    ${If} $R5 == ""
      StrCpy $R5 "${MAINBINARYNAME}.exe"
    ${EndIf}
    StrCpy $R5 "$R4\$R5"

    ; Both names use the same program file name, so never touch our own folder.
    ${If} $R4 != ""
    ${AndIf} $R4 != $INSTDIR
    ${AndIf} ${FileExists} "$R5"
      ; Which shortcuts launch the other install ($R7 desktop, $R8 Start menu).
      !insertmacro IsShortcutTarget "$DESKTOP\${NAME}.lnk" "$R5"
      Pop $R7
      !insertmacro IsShortcutTarget "$SMPROGRAMS\${NAME}.lnk" "$R5"
      Pop $R8

      ; An auto-update starts this installer as the old app quits, so its program
      ; (or a PDF worker it started) may hold the file for a moment.
      StrCpy $R6 0
      ${Do}
        Delete "$R5"
        ${IfNot} ${FileExists} "$R5"
          ${ExitDo}
        ${EndIf}
        IntOp $R6 $R6 + 1
        ${If} $R6 >= 20
          ${ExitDo}
        ${EndIf}
        Sleep 500
      ${Loop}

      ${IfNot} ${FileExists} "$R5"
        ; Every file the bundle installs (tauri.conf.json bundle.resources). Only
        ; these, so a folder the user shares with other files is never emptied.
        Delete "$R4\uninstall.exe"
        Delete "$R4\THIRD-PARTY-NOTICES.txt"
        RMDir /r "$R4\pdfium"
        RMDir "$R4"
        DeleteRegKey SHCTX "${NOVA_UNINSTALL_ROOT}\${NAME}"

        ; Not unpinned first, as an uninstaller would: Windows treats that as
        ; unpinning the program, which also removes its taskbar pin.
        ${If} $R8 = 1
          Delete "$SMPROGRAMS\${NAME}.lnk"
          ${IfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
            CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
            !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
          ${EndIf}
        ${EndIf}

        ${If} $R7 = 1
          Delete "$DESKTOP\${NAME}.lnk"
          ${IfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
            CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
            !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
          ${EndIf}
        ${EndIf}

        ; Keep taskbar pins working: Windows cannot pin programmatically, so a pin
        ; is pointed at the new program rather than removed. A pin keeps the file
        ; name it was created with (often an earlier product name), so every pin
        ; is checked by what it launches, not by its name.
        FindFirst $R6 $R9 "${NOVA_TASKBAR_PINS}\*.lnk"
        ${DoWhile} $R9 != ""
          !insertmacro IsShortcutTarget "${NOVA_TASKBAR_PINS}\$R9" "$R5"
          Pop $R7
          ${If} $R7 = 1
            !insertmacro SetShortcutTarget "${NOVA_TASKBAR_PINS}\$R9" "$INSTDIR\${MAINBINARYNAME}.exe"
          ${EndIf}
          FindNext $R6 $R9
        ${Loop}
        FindClose $R6

        ; "Open with > Always" makes Windows register the program by file name
        ; (Applications\novapdf.exe) with its full path, and the user's default
        ; for .pdf then points there. Both names share that file name, so point
        ; the path at this install and the user's default keeps working. The
        ; protected default (UserChoice) itself is left alone.
        StrCpy $R9 "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command"
        ReadRegStr $R6 SHCTX "$R9" ""
        ${If} $R6 == '"$R5" "%1"'
          WriteRegStr SHCTX "$R9" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
          !insertmacro UPDATEFILEASSOC
        ${EndIf}
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Every name the app has shipped under. Add the old name here when renaming.
  !insertmacro NOVA_RETIRE_INSTALL "NovaPDF"
  !insertmacro NOVA_RETIRE_INSTALL "NovaQuire"
!macroend
