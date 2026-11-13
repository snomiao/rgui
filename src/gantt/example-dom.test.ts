import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, expect, test } from "bun:test";
import { plainGantt } from "./example-dom";

afterAll(() => GlobalRegistrator.unregister());

test("a custom plain-DOM renderer on the shared core: rows, fold by click, ctrl+wheel zoom", () => {
  const now = 1_800_000_000,
    host = document.createElement("div");
  document.body.appendChild(host);
  let opened = "";
  const g = plainGantt(host, { now: () => now, foldKey: null, onOpen: (b) => (opened = b.id) });
  const c = g.controller;
  c.setBars([
    { id: "/l/cat/a", lane: "l", a: now - 3600, due: now + 3600, name: "a" },
    { id: "/l/cat/b", lane: "l", a: now - 7200, due: now - 3600, name: "b" },
  ]);
  g.draw();
  const names = () => [...host.querySelectorAll<HTMLElement>("[data-id]")].map((e) => e.textContent);
  expect(names()).toEqual(["l", "▾ cat", "a", "b"]);
  host.querySelector<HTMLElement>('[data-id="/l/cat"]')!.click();
  g.draw();
  expect(names()).toEqual(["l", "▸ cat"]);
  host.querySelector<HTMLElement>('[data-id="/l/cat"]')!.click();
  g.draw();
  host.querySelector<HTMLElement>('[data-id="/l/cat/a"]')!.click();
  expect(opened).toBe("/l/cat/a");
  const spp = c.spp;
  // happy-dom drops ctrlKey from WheelEvent init: set it on the event
  const w = new WheelEvent("wheel", { deltaY: -100, clientX: 100 });
  Object.defineProperty(w, "ctrlKey", { value: true });
  host.firstElementChild!.dispatchEvent(w);
  expect(c.spp).toBeLessThan(spp);
  g.destroy();
});

test("canvas renderer (GanttChart) on the core: blank rows from arrange render as empty .rg-blank rows", async () => {
  const { GanttChart, stableSlots } = await import("./canvas");
  const now = 1_800_000_000,
    host = document.createElement("div");
  document.body.appendChild(host);
  const chart = new GanttChart(host, { now: () => now, foldKey: null, focusKey: null, virtual: false, canvas: false }); // happy-dom has no 2D context
  const s = stableSlots();
  chart.controller.arrange = s.arrange;
  const bar = (id: string) => ({ id, lane: "l", a: now - 60, due: now + 60, name: id });
  chart.setBars([bar("/l/a"), bar("/l/b")]);
  chart.setBars([bar("/l/b")]);
  expect(chart.rows.querySelectorAll(".rg-blank").length).toBe(1);
  expect(chart.controller.lines.map((l) => (l.blank ? "_" : (l.bar?.id ?? l.lane)))).toEqual(["l", "_", "/l/b"]);
  chart.destroy();
});
