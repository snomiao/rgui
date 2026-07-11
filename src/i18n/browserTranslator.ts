export type TranslatorAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable";

export interface NativeTextTranslator {
  translate(input: string): Promise<string>;
  destroy?: () => void;
}

interface TranslationPair {
  sourceLanguage: string;
  targetLanguage: string;
}

interface TranslationMonitor {
  addEventListener(
    type: "downloadprogress",
    listener: (event: Event & { loaded: number }) => void,
  ): void;
}

export interface NativeTranslatorApi {
  availability(options: TranslationPair): Promise<TranslatorAvailability>;
  create(
    options: TranslationPair & {
      monitor?: (monitor: TranslationMonitor) => void;
    },
  ): Promise<NativeTextTranslator>;
}

export function getNativeTranslatorApi(
  scope: typeof globalThis = globalThis,
): NativeTranslatorApi | undefined {
  const candidate = (scope as typeof globalThis & {
    Translator?: NativeTranslatorApi;
  }).Translator;
  if (
    !candidate ||
    typeof candidate.availability !== "function" ||
    typeof candidate.create !== "function"
  ) {
    return undefined;
  }
  return candidate;
}

export function preferredTargetLanguage(
  languages: readonly string[] = navigator.languages,
): string | undefined {
  for (const languageTag of languages) {
    try {
      const locale = new Intl.Locale(languageTag);
      if (locale.language === "en") continue;
      if (locale.language === "zh" && locale.maximize().script === "Hant") {
        return "zh-Hant";
      }
      return locale.language;
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function createNativeTranslator(
  api: NativeTranslatorApi,
  targetLanguage: string,
  onDownloadProgress?: (progress: number) => void,
): Promise<NativeTextTranslator> {
  return api.create({
    sourceLanguage: "en",
    targetLanguage,
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        onDownloadProgress?.(event.loaded);
      });
    },
  });
}
