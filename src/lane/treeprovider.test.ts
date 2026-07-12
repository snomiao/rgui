import { describe, expect, test } from "bun:test";
import {
  TreeListingStore,
  type TreeListOptions,
  type TreeListPage,
  type TreeProvider,
  type TreeWatchEvent,
} from "./treeprovider.js";

const file = (name: string) => ({ name, kind: "file" as const });
const signal = () => new AbortController();

describe("TreeListingStore", () => {
  test("distinguishes unknown, partial, and complete-empty", async () => {
    const pages: TreeListPage[] = [
      { entries: [file("a")], cursor: "next", complete: false, version: 1 },
      { entries: [], complete: true, version: 1 },
    ];
    const provider: TreeProvider = { list: async () => pages.shift()! };
    const store = new TreeListingStore(provider);
    expect(store.snapshot("x").status).toBe("unknown");
    expect((await store.load("x", { signal: signal().signal })).status).toBe("partial");
    expect((await store.load("x", { signal: signal().signal })).status).toBe("complete");

    const empty = new TreeListingStore({
      list: async () => ({ entries: [], complete: true, version: "empty" }),
    });
    const result = await empty.load("empty", { signal: signal().signal });
    expect(result.status).toBe("complete");
    expect(result.entries).toEqual([]);
  });

  test("deduplicates concurrent requests per path", async () => {
    let calls = 0;
    let resolve!: (page: TreeListPage) => void;
    const provider: TreeProvider = {
      list: () => {
        calls++;
        return new Promise<TreeListPage>((r) => { resolve = r; });
      },
    };
    const store = new TreeListingStore(provider);
    const controller = signal();
    const a = store.load("x", { signal: controller.signal });
    const b = store.load("x", { signal: controller.signal });
    expect(a).toBe(b);
    await Promise.resolve();
    expect(calls).toBe(1);
    resolve({ entries: [file("a")], complete: true, version: 1 });
    expect((await a).entries).toEqual([file("a")]);
  });

  test("merges cursor pages stably and replaces duplicate names", async () => {
    const cursors: Array<string | undefined> = [];
    const provider: TreeProvider = {
      async list(_path, options) {
        cursors.push(options.cursor);
        return options.cursor
          ? { entries: [{ ...file("a"), size: 2 }, file("b")], complete: true, version: "v1" }
          : { entries: [{ ...file("a"), size: 1 }], cursor: "p2", complete: false, version: "v1" };
      },
    };
    const store = new TreeListingStore(provider);
    await store.load("x", { signal: signal().signal });
    const done = await store.load("x", { signal: signal().signal });
    expect(cursors).toEqual([undefined, "p2"]);
    expect(done.entries).toEqual([{ ...file("a"), size: 2 }, file("b")]);
  });

  test("generation + abort prevent stale completion after invalidation", async () => {
    let options!: TreeListOptions;
    let resolve!: (page: TreeListPage) => void;
    const provider: TreeProvider = {
      list: (_path, o) => {
        options = o;
        return new Promise<TreeListPage>((r) => { resolve = r; });
      },
    };
    const store = new TreeListingStore(provider);
    const pending = store.load("x", { signal: signal().signal });
    await Promise.resolve();
    store.invalidate("x");
    expect(options.signal.aborted).toBe(true);
    resolve({ entries: [file("stale")], complete: true, version: 1 });
    await pending;
    expect(store.snapshot("x").status).toBe("unknown");
    expect(store.snapshot("x").entries).toEqual([]);
  });

  test("pagination version drift discards mixed pages and requests restart", async () => {
    let page = 0;
    const provider: TreeProvider = {
      async list() {
        page++;
        return page === 1
          ? { entries: [file("a")], cursor: "p2", complete: false, version: 1 }
          : { entries: [file("b")], complete: true, version: 2 };
      },
    };
    const store = new TreeListingStore(provider);
    await store.load("x", { signal: signal().signal });
    const drift = await store.load("x", { signal: signal().signal });
    expect(drift.status).toBe("unknown");
    expect(drift.entries).toEqual([]);
    expect(drift.restartRequired).toBe(true);
  });

  test("partial pages without a cursor expose a protocol error", async () => {
    const store = new TreeListingStore({
      list: async () => ({ entries: [], complete: false, version: 1 }),
    });
    const result = await store.load("x", { signal: signal().signal });
    expect(result.status).toBe("unknown");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.loading).toBe(false);
  });

  test("normalizes synchronous provider throws into settled error state", async () => {
    const store = new TreeListingStore({
      list() {
        throw new Error("sync failure");
      },
    });
    const result = await store.load("x", { signal: signal().signal });
    expect(result.status).toBe("unknown");
    expect(result.loading).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
  });

  test("an already-aborted request performs no provider I/O", async () => {
    let calls = 0;
    const store = new TreeListingStore({
      async list() {
        calls++;
        return { entries: [], complete: true, version: 1 };
      },
    });
    const controller = signal();
    controller.abort();
    const result = await store.load("x", { signal: controller.signal });
    expect(calls).toBe(0);
    expect(result.status).toBe("unknown");
    expect(result.loading).toBe(false);
    expect(result.error).toBeUndefined();
  });

  test("watch is an invalidation ping; equal versions are ignored", async () => {
    let ping!: (event: TreeWatchEvent) => void;
    let stopped = 0;
    const provider: TreeProvider = {
      list: async () => ({ entries: [file("a")], complete: true, version: "v1" }),
      watch: (_path, cb) => {
        ping = cb;
        return () => { stopped++; };
      },
    };
    const store = new TreeListingStore(provider);
    await store.load("x", { signal: signal().signal });
    const stop = store.watch("x");
    ping({ path: "x", version: "v1" });
    expect(store.snapshot("x").status).toBe("complete");
    ping({ path: "x", version: "v2" });
    expect(store.snapshot("x").status).toBe("unknown");
    stop();
    expect(stopped).toBe(1);
  });

  test("errors preserve partial progress and explicit retry is host-driven", async () => {
    let calls = 0;
    const provider: TreeProvider = {
      async list() {
        calls++;
        if (calls === 1) return { entries: [file("a")], cursor: "p2", complete: false, version: 1 };
        if (calls === 2) throw new Error("offline");
        return { entries: [file("b")], complete: true, version: 1 };
      },
    };
    const store = new TreeListingStore(provider);
    await store.load("x", { signal: signal().signal });
    const failed = await store.load("x", { signal: signal().signal });
    expect(failed.status).toBe("partial");
    expect(failed.error).toBeInstanceOf(Error);
    const retried = await store.load("x", { signal: signal().signal });
    expect(retried.status).toBe("complete");
    expect(retried.entries.map((entry) => entry.name)).toEqual(["a", "b"]);
  });
});
