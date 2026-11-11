import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "../../src/app/manifest";

describe("NGTManager naming", () => {
  it("uses the English name in browser and installed web app metadata", () => {
    expect(manifest()).toMatchObject({
      name: "NGTManager",
      short_name: "NGTManager",
      start_url: "/",
    });
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    expect(layout).toContain('default: "NGTManager"');
    expect(layout).toContain('template: "%s · NGTManager"');
    expect(layout).toContain('applicationName: "NGTManager"');
  });

  it("uses the dedicated manager identity and per-user installation directory", () => {
    const installer = readFileSync("installer/windows-studio.iss", "utf8");
    expect(installer).toContain('#define AppName "NGTManager"');
    expect(installer).toContain(
      '#define AppId "{{E7B1C553-4F5A-4239-A4C2-7DCA1DC27121}"',
    );
    expect(installer).toContain("AppName={#AppName}");
    expect(installer).toContain("UninstallDisplayName={#AppName}");
    for (const location of ["autodesktop", "autoprograms"]) {
      expect(installer).toContain(`Name: "{${location}}\\{#AppName}";`);
      expect(installer).toContain(
        `DeleteFile(ExpandConstant('{${location}}\\NGT 工作室管理系统.url'))`,
      );
    }
    expect(installer).toContain("DefaultDirName={localappdata}\\NGTManager");
  });
});
