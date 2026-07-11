export type LabelEncoding = "matched" | "shared" | "split";

export interface EyeVisibility {
  left: number;
  right: number;
}

export interface LabelPresentation {
  tens: EyeVisibility;
  ones: EyeVisibility;
}

export const MATCHED_ECHO_OPACITY = 0.42;

export function labelPresentation(
  encoding: LabelEncoding,
  peek: boolean,
): LabelPresentation {
  if (peek || encoding === "shared") {
    return {
      tens: { left: 1, right: 1 },
      ones: { left: 1, right: 1 },
    };
  }
  if (encoding === "matched") {
    return {
      tens: { left: 1, right: MATCHED_ECHO_OPACITY },
      ones: { left: MATCHED_ECHO_OPACITY, right: 1 },
    };
  }
  return {
    tens: { left: 1, right: 0 },
    ones: { left: 0, right: 1 },
  };
}
