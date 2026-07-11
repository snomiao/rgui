export type WorldInputContext = "world" | "ui" | "transit";

export interface LatchedAction {
  action: string;
  code: string;
  pressedAt: number;
}

export interface InputRouterOptions {
  resolveAction: (code: string) => string | undefined;
  onPress: (action: LatchedAction) => void;
  onRelease: (action: LatchedAction) => void;
}

export class WorldInputRouter {
  private context: WorldInputContext = "world";
  private readonly held = new Map<string, LatchedAction>();

  constructor(private readonly options: InputRouterOptions) {}

  setContext(context: WorldInputContext, _now: number) {
    if (context === this.context) return;
    this.releaseAll();
    this.context = context;
  }


  resync(heldCodes: Iterable<string>, now: number) {
    if (this.context !== "world") return;
    const physicallyHeld = new Set(heldCodes);
    for (const code of [...this.held.keys()]) {
      if (!physicallyHeld.has(code)) this.keyUp(code);
    }
    for (const code of physicallyHeld) this.keyDown(code, now);
  }

  keyDown(code: string, now: number): boolean {
    if (this.context !== "world" || this.held.has(code)) return false;
    const action = this.options.resolveAction(code);
    if (!action) return false;
    const latched = { action, code, pressedAt: now };
    this.held.set(code, latched);
    this.options.onPress(latched);
    return true;
  }

  keyUp(code: string): boolean {
    const latched = this.held.get(code);
    if (!latched) return false;
    this.held.delete(code);
    this.options.onRelease(latched);
    return true;
  }

  activeActions(): readonly LatchedAction[] {
    return [...this.held.values()];
  }

  releaseAll() {
    const released = [...this.held.values()];
    this.held.clear();
    for (const action of released) this.options.onRelease(action);
  }
}
