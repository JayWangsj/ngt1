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

  it("renames installer entries while preserving the existing installation identity", () => {
    const installer = readFileSync("installer/windows-studio.iss", "utf8");
    expect(installer).toContain('#define AppName "NGTManager"');
    expect(installer).toContain(
      '#define AppId "{{D7F74E80-B49C-4C3D-B6FC-18C04DAA9D31}"',
    );
    expect(installer).toContain("AppName={#AppName}");
    expect(installer).toContain("UninstallDisplayName={#AppName}");
    for (const location of ["autodesktop", "autoprograms"]) {
      expect(installer).toContain(`Name: "{${location}}\\{#AppName}";`);
      expect(installer).toContain(
        `Type: files; Name: "{${location}}\\NGT 工作室管理系统.url"`,
      );
    }
    expect(installer).toContain("DefaultDirName={localappdata}\\NGT");
  });
});
