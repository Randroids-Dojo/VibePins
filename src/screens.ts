// App-shell screen state machine (GDD 06-reuse-and-tech, REQ-045). Drives the
// three top-level states the game moves between:
//   menu     the title/start screen shown on boot and after a game ends, with a
//            "play" action and a settings toggle.
//   playing  the live 3D game; the shot loop in src/main.ts owns this state.
//   summary  the end-of-game screen with the final score and a "play again"
//            action that returns to a fresh game.
//   match    the async-multiplayer hub: create / join a match, the lobby, the
//            your-turn vs waiting-for-player states, and the final standings
//            (GDD 05-async-multiplayer, REQ-050/051). Reachable from the menu,
//            and returns to the menu.
//
// Pure: no DOM, no Three.js, no clock. It only tracks the current screen and the
// legal transitions between them, and notifies a listener on every change so the
// DOM shell (src/main.ts) can show/hide the right overlay. Keeping it pure means
// the transition rules are unit-testable without a browser.
//
// The transition graph is deliberately small and one-directional per action so
// the shell stays a single consistent flow (AGENTS rule 7):
//   menu --start--> playing
//   menu --openMatch--> match
//   match --bowlMatch--> playing   // bowl your async-match frame in-browser
//   match --toMenu--> menu
//   playing --toMatch--> match     // return to the hub after a match frame
//   playing --finish--> summary
//   summary --playAgain--> playing
//   summary --toMenu--> menu
//   (any) --reset--> menu        // a hard return to the title, e.g. on boot

export type Screen = 'menu' | 'playing' | 'summary' | 'match';

export type ScreenListener = (screen: Screen, previous: Screen) => void;

export class Screens {
  private current: Screen;
  private listener: ScreenListener | null = null;

  constructor(initial: Screen = 'menu') {
    this.current = initial;
  }

  get screen(): Screen {
    return this.current;
  }

  // Register the single shell listener invoked on every transition. Returns an
  // unsubscribe function. Only one listener is supported; registering a new one
  // replaces it (the shell owns exactly one view layer).
  onChange(listener: ScreenListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  // Start a game from the menu. No-op (and no notification) if not on the menu,
  // so a stray confirm during play cannot restart the loop.
  start(): boolean {
    return this.transition('playing', this.current === 'menu');
  }

  // Open the async-multiplayer hub from the menu. Only valid on the menu, so a
  // stray open during play or summary cannot pull the shell off its flow.
  openMatch(): boolean {
    return this.transition('match', this.current === 'menu');
  }

  // Leave the match hub to bowl your async-match frame in the live game (REQ-053).
  // Only valid from the hub, so it cannot pull the shell off its flow elsewhere.
  bowlMatch(): boolean {
    return this.transition('playing', this.current === 'match');
  }

  // Return to the match hub after bowling a match frame. Only valid while playing,
  // so a solo game (which finishes to the summary) never lands back in the hub.
  toMatch(): boolean {
    return this.transition('match', this.current === 'playing');
  }

  // Finish the live game and show the summary. Only valid while playing.
  finish(): boolean {
    return this.transition('summary', this.current === 'playing');
  }

  // From the summary, start a fresh game. Only valid on the summary screen.
  playAgain(): boolean {
    return this.transition('playing', this.current === 'summary');
  }

  // Return to the title menu from the summary or the match hub. Both back out to
  // the same calm title screen, keeping the flow consistent (AGENTS rule 7).
  toMenu(): boolean {
    return this.transition('menu', this.current === 'summary' || this.current === 'match');
  }

  private transition(next: Screen, allowed: boolean): boolean {
    if (!allowed || next === this.current) return false;
    const previous = this.current;
    this.current = next;
    this.listener?.(next, previous);
    return true;
  }
}
