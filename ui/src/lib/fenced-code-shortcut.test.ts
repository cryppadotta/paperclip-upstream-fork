import { describe, expect, it } from "vitest";
import { parseFenceShortcut } from "./fenced-code-shortcut";

describe("parseFenceShortcut", () => {
  it("accepts a plain triple-backtick fence before the caret", () => {
    expect(parseFenceShortcut("```")).toBe("");
  });

  it("accepts a language-tagged triple-backtick fence before the caret", () => {
    expect(parseFenceShortcut("```ts")).toBe("ts");
    expect(parseFenceShortcut("```tsx")).toBe("tsx");
    expect(parseFenceShortcut("```objective-c")).toBe("objective-c");
  });

  it("allows markdown's standard leading indentation for fences", () => {
    expect(parseFenceShortcut("   ```json")).toBe("json");
  });

  it("rejects fences when non-whitespace content remains after the caret", () => {
    expect(parseFenceShortcut("```", "const x = 1")).toBeNull();
  });

  it("rejects non-fence text", () => {
    expect(parseFenceShortcut("before ```")).toBeNull();
    expect(parseFenceShortcut("    ```")).toBeNull();
    expect(parseFenceShortcut("``")).toBeNull();
  });
});
