// All player input goes through here so touch controls can be added later
// by calling `emit` from on-screen buttons.

export type Action = 'left' | 'right' | 'up' | 'down' | 'confirm';
export type Phase = 'press' | 'release';
export type InputHandler = (action: Action, phase: Phase, time: number) => void;

const KEYMAP: Record<string, Action> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Space: 'confirm',
};

export class InputController {
  private handlers: InputHandler[] = [];
  private held = new Set<Action>();

  private onKeyDown = (e: KeyboardEvent) => {
    const action = KEYMAP[e.code];
    if (!action) return;
    e.preventDefault();
    if (e.repeat || this.held.has(action)) return;
    this.emit(action, 'press', e.timeStamp);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    const action = KEYMAP[e.code];
    if (!action) return;
    e.preventDefault();
    this.emit(action, 'release', e.timeStamp);
  };

  private onBlur = () => {
    for (const a of [...this.held]) this.emit(a, 'release', performance.now());
  };

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  /** Time uses the performance.now() clock. */
  emit(action: Action, phase: Phase, time: number = performance.now()): void {
    if (phase === 'press') this.held.add(action);
    else if (!this.held.delete(action)) return;
    for (const h of this.handlers) h(action, phase, time);
  }

  isHeld(action: Action): boolean {
    return this.held.has(action);
  }

  on(handler: InputHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.handlers = [];
  }
}
