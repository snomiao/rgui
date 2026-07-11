import { describe, expect, test } from "bun:test";
import {
  MATCHED_ECHO_OPACITY,
  labelPresentation,
} from "./labelEncoding.js";

describe("binocular label encodings", () => {
  test("matched keeps both digit contours in both eyes", () => {
    expect(labelPresentation("matched", false)).toEqual({
      tens: { left: 1, right: MATCHED_ECHO_OPACITY },
      ones: { left: MATCHED_ECHO_OPACITY, right: 1 },
    });
  });

  test("shared presents an identical complete label to both eyes", () => {
    expect(labelPresentation("shared", false)).toEqual({
      tens: { left: 1, right: 1 },
      ones: { left: 1, right: 1 },
    });
  });

  test("split retains the legacy eye-exclusive experiment", () => {
    expect(labelPresentation("split", false)).toEqual({
      tens: { left: 1, right: 0 },
      ones: { left: 0, right: 1 },
    });
  });

  test("peek overrides every mode with a shared complete label", () => {
    for (const encoding of ["matched", "shared", "split"] as const) {
      expect(labelPresentation(encoding, true)).toEqual(
        labelPresentation("shared", false),
      );
    }
  });
});
