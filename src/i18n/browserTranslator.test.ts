import { describe, expect, test } from "bun:test";
import {
  createNativeTranslator,
  getNativeTranslatorApi,
  preferredTargetLanguage,
  type NativeTranslatorApi,
} from "./browserTranslator.js";

describe("browser-provided translation", () => {
  test("chooses the first non-English browser language", () => {
    expect(preferredTargetLanguage(["en-US", "ja-JP", "fr-FR"])).toBe("ja");
    expect(preferredTargetLanguage(["en", "en-GB"])).toBeUndefined();
    expect(preferredTargetLanguage(["zh-TW"])).toBe("zh-Hant");
  });

  test("feature-detects the native Translator API", () => {
    const api = {
      availability: async () => "available" as const,
      create: async () => ({ translate: async (text: string) => text }),
    } satisfies NativeTranslatorApi;

    expect(getNativeTranslatorApi({ Translator: api } as never)).toBe(api);
    expect(getNativeTranslatorApi({} as never)).toBeUndefined();
  });

  test("creates an English-to-target translator and reports downloads", async () => {
    const progress: number[] = [];
    const api: NativeTranslatorApi = {
      availability: async () => "downloadable",
      async create(options) {
        options.monitor?.({
          addEventListener(_type, listener) {
            listener(Object.assign(new Event("downloadprogress"), { loaded: 0.5 }));
          },
        });
        expect(options.sourceLanguage).toBe("en");
        expect(options.targetLanguage).toBe("fr");
        return { translate: async (text) => `fr:${text}` };
      },
    };

    const translator = await createNativeTranslator(api, "fr", (value) =>
      progress.push(value),
    );

    expect(await translator.translate("Cube")).toBe("fr:Cube");
    expect(progress).toEqual([0.5]);
  });
});
