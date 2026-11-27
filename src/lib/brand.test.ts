import { describe, expect, it } from "vitest";
import tauriConf from "../../src-tauri/tauri.conf.json";
import installerHooks from "../../src-tauri/windows/hooks.nsh?raw";
import { APP_NAME } from "./brand";

describe("brand", () => {
  it("shows the same name as the window, installer and app bundle", () => {
    expect(APP_NAME).toBe(tauriConf.productName);
  });

  it("keeps the identifier existing installs update through", () => {
    // Settings, WebView data, the macOS bundle id and the single-instance lock are
    // keyed by it. Changing it strands every installed copy; see README.
    expect(tauriConf.identifier).toBe("io.novapdf.app");
  });

  it("retires installs under every other name with the installer hook", () => {
    expect(tauriConf.bundle.windows.nsis.installerHooks).toBe("./windows/hooks.nsh");
    // The hook lists each name the app has shipped under; the current one must be there
    // so a later rename (or a rename back) retires it.
    expect(installerHooks).toContain(`!insertmacro NOVA_RETIRE_INSTALL "${APP_NAME}"`);
    expect(installerHooks).toContain(`!insertmacro NOVA_RETIRE_INSTALL "NovaPDF"`);
  });

  it("removes every bundled resource when retiring an install", () => {
    // The hook deletes the other install's files by name, so a new resource left out
    // of it would stay behind in the old folder.
    for (const resource of tauriConf.bundle.resources) {
      const top = resource.split("/")[0];
      const removal = top.includes("*") ? null : resource.includes("/") ? `RMDir /r "$R4\\${top}"` : `Delete "$R4\\${top}"`;
      expect(removal, resource).not.toBeNull();
      expect(installerHooks, resource).toContain(removal);
    }
  });
});
