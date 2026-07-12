/** Pure protocol + request lifecycle for lazy folder-tree providers. */

export type TreeVersion = string | number;
export type TreeListingStatus = "unknown" | "partial" | "complete";

export interface TreeProviderEntry {
  name: string;
  kind: "file" | "directory";
  size?: number;
  path?: string;
}

export interface TreeListOptions {
  cursor?: string;
  limit?: number;
  /** Every request is abortable; providers must observe this signal. */
  signal: AbortSignal;
}

export interface TreeListPage {
  entries: readonly TreeProviderEntry[];
  cursor?: string;
  complete: boolean;
  /** Opaque, path-local snapshot token. No global ordering is required. */
  version: TreeVersion;
}

export interface TreeStat {
  kind: "file" | "directory";
  size?: number;
  version?: TreeVersion;
}

export interface TreeWatchEvent {
  path: string;
  version?: TreeVersion;
}

export interface TreeProvider {
  list(path: string, options: TreeListOptions): Promise<TreeListPage>;
  stat?(path: string, options: { signal: AbortSignal }): Promise<TreeStat | null>;
  read?(path: string, options: { signal: AbortSignal }): Promise<string | Uint8Array | null>;
  /** Invalidation ping only. Consumers re-list; watch payloads are not mutations. */
  watch?(path: string, onInvalidate: (event: TreeWatchEvent) => void): () => void;
}

export interface TreeListingSnapshot {
  path: string;
  status: TreeListingStatus;
  /** complete + [] means known-empty; unknown + [] means not listed. */
  entries: readonly TreeProviderEntry[];
  cursor?: string;
  version?: TreeVersion;
  generation: number;
  loading: boolean;
  error?: unknown;
  /** True after pagination snapshot drift; the next load restarts at page one. */
  restartRequired: boolean;
}

export interface TreeLoadOptions {
  signal: AbortSignal;
  limit?: number;
}

interface MutableListing {
  path: string;
  status: TreeListingStatus;
  entries: TreeProviderEntry[];
  cursor?: string;
  version?: TreeVersion;
  generation: number;
  loading: boolean;
  error?: unknown;
  restartRequired: boolean;
  controller?: AbortController;
  promise?: Promise<TreeListingSnapshot>;
  unwatch?: () => void;
}

const unknownState = (path: string): MutableListing => ({
  path,
  status: "unknown",
  entries: [],
  generation: 0,
  loading: false,
  restartRequired: false,
});

const snapshotOf = (state: MutableListing): TreeListingSnapshot => ({
  path: state.path,
  status: state.status,
  entries: state.entries.map((entry) => ({ ...entry })),
  cursor: state.cursor,
  version: state.version,
  generation: state.generation,
  loading: state.loading,
  error: state.error,
  restartRequired: state.restartRequired,
});

const mergeEntries = (
  previous: readonly TreeProviderEntry[],
  incoming: readonly TreeProviderEntry[],
): TreeProviderEntry[] => {
  const out = previous.map((entry) => ({ ...entry }));
  const index = new Map(out.map((entry, i) => [entry.name, i]));
  for (const entry of incoming) {
    const at = index.get(entry.name);
    if (at === undefined) {
      index.set(entry.name, out.length);
      out.push({ ...entry });
    } else {
      out[at] = { ...entry };
    }
  }
  return out;
};

/**
 * Per-path listing state machine. It owns request deduplication, generation
 * guards, aborts, cursor merging, and watch invalidation. Retry timing and
 * backoff remain host-adapter policy.
 */
export class TreeListingStore {
  private readonly states = new Map<string, MutableListing>();

  constructor(
    readonly provider: TreeProvider,
    private readonly onChange: (snapshot: TreeListingSnapshot) => void = () => {},
  ) {}

  snapshot(path: string): TreeListingSnapshot {
    return snapshotOf(this.state(path));
  }

  /** Load exactly one page. Concurrent calls for a path share one promise. */
  load(path: string, options: TreeLoadOptions): Promise<TreeListingSnapshot> {
    const state = this.state(path);
    if (state.promise) return state.promise;
    if (state.status === "complete" && !state.restartRequired) {
      return Promise.resolve(snapshotOf(state));
    }

    const generation = ++state.generation;
    const requestedCursor = state.restartRequired ? undefined : state.cursor;
    if (state.restartRequired) this.resetListing(state);
    const controller = new AbortController();
    state.controller = controller;
    state.loading = true;
    state.error = undefined;
    this.emit(state);

    const abort = () => controller.abort(options.signal.reason);
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });

    const promise = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) return Promise.reject(controller.signal.reason);
        return this.provider.list(path, {
          cursor: requestedCursor,
          limit: options.limit,
          signal: controller.signal,
        });
      })
      .then((page) => {
        if (state.generation !== generation || controller.signal.aborted) {
          return snapshotOf(state);
        }
        if (!page.complete && !page.cursor) {
          throw new Error(`TreeProvider.list(${JSON.stringify(path)}): partial page requires cursor`);
        }
        if (
          requestedCursor !== undefined &&
          state.version !== undefined &&
          page.version !== state.version
        ) {
          // A cursor from version A cannot merge into version B. Discard the
          // mixed snapshot; the viewport scheduler restarts from page one.
          this.resetListing(state);
          state.restartRequired = true;
          return snapshotOf(state);
        }
        state.entries = requestedCursor === undefined
          ? mergeEntries([], page.entries)
          : mergeEntries(state.entries, page.entries);
        state.version = page.version;
        state.cursor = page.complete ? undefined : page.cursor;
        state.status = page.complete ? "complete" : "partial";
        state.restartRequired = false;
        return snapshotOf(state);
      })
      .catch((error) => {
        if (state.generation === generation && !controller.signal.aborted) {
          state.error = error;
        }
        return snapshotOf(state);
      })
      .finally(() => {
        options.signal.removeEventListener("abort", abort);
        if (state.generation === generation) {
          state.loading = false;
          state.controller = undefined;
          state.promise = undefined;
          this.emit(state);
        }
      })
      // Earlier stages may have captured a snapshot while loading was still
      // true. Always resolve callers from the settled state after finally.
      .then(() => snapshotOf(state));
    state.promise = promise;
    return promise;
  }

  /** Abort and forget a path's listing. Stale completions cannot repopulate it. */
  invalidate(path: string, version?: TreeVersion): TreeListingSnapshot {
    const state = this.state(path);
    if (version !== undefined && state.version === version) return snapshotOf(state);
    state.generation++;
    state.controller?.abort();
    state.promise = undefined;
    state.controller = undefined;
    this.resetListing(state);
    this.emit(state);
    return snapshotOf(state);
  }

  abort(path: string): void {
    const state = this.states.get(path);
    if (!state?.loading) return;
    state.generation++;
    state.controller?.abort();
    state.loading = false;
    state.promise = undefined;
    state.controller = undefined;
    this.emit(state);
  }

  /** Attach provider invalidations. The callback resets state; it never mutates entries. */
  watch(path: string): () => void {
    const state = this.state(path);
    state.unwatch?.();
    const stop = this.provider.watch?.(path, (event) => {
      this.invalidate(path, event.version);
    }) ?? (() => {});
    state.unwatch = stop;
    return () => {
      if (state.unwatch === stop) state.unwatch = undefined;
      stop();
    };
  }

  dispose(): void {
    for (const state of this.states.values()) {
      state.generation++;
      state.controller?.abort();
      state.unwatch?.();
    }
    this.states.clear();
  }

  private state(path: string): MutableListing {
    let state = this.states.get(path);
    if (!state) {
      state = unknownState(path);
      this.states.set(path, state);
    }
    return state;
  }

  private resetListing(state: MutableListing): void {
    state.status = "unknown";
    state.entries = [];
    state.cursor = undefined;
    state.version = undefined;
    state.error = undefined;
    state.restartRequired = false;
    state.loading = false;
  }

  private emit(state: MutableListing): void {
    this.onChange(snapshotOf(state));
  }
}
