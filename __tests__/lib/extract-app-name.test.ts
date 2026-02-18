import { extractAppName } from "@/lib/extract-app-name";

describe("extractAppName", () => {
  // Colon convention: "AppName: description"
  it("extracts app name before colon", () => {
    expect(extractAppName("LensCycle: Contact lens reminder app")).toBe("LensCycle");
  });

  it("extracts hyphenated name before colon", () => {
    expect(extractAppName("My-App: some description")).toBe("My-App");
  });

  it("ignores colon if prefix has spaces", () => {
    // "My Cool App: description" — prefix has spaces, not an identifier
    // Falls through to PascalCase match
    expect(extractAppName("My Cool App: description")).toBe("My");
  });

  // Single identifier title
  it("returns the title if it is a single identifier", () => {
    expect(extractAppName("LensCycle")).toBe("LensCycle");
  });

  it("returns the title for underscore identifiers", () => {
    expect(extractAppName("lens_cycle")).toBe("lens_cycle");
  });

  // PascalCase first word fallback
  it("extracts first PascalCase word from multi-word title", () => {
    expect(extractAppName("LensCycle Pipeline v2 Rebuild")).toBe("LensCycle");
  });

  it("extracts PascalCase app name with numbers", () => {
    expect(extractAppName("Patch2Cycle some other words")).toBe("Patch2Cycle");
  });

  it("extracts PascalCase when followed by punctuation", () => {
    expect(extractAppName("SoulCycle — meditation tracking")).toBe("SoulCycle");
  });

  // Null/undefined/empty cases
  it("returns null for undefined", () => {
    expect(extractAppName(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractAppName("")).toBeNull();
  });

  it("returns null for lowercase title with no PascalCase", () => {
    expect(extractAppName("some random title")).toBeNull();
  });

  it("returns null for title starting with number", () => {
    expect(extractAppName("123 not an app")).toBeNull();
  });
});
