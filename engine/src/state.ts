import type { ChannelId } from "./channels";
import type { EngineState } from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

export function createInitialState(channelId: ChannelId): EngineState {
  return {
    status: "IDLE",
    channelId,
    failStreak: 0,
    updatedAt: nowIso(),
  };
}

export class StateStore {
  private state: EngineState;

  constructor(initialState: EngineState) {
    this.state = initialState;
  }

  getState(): EngineState {
    return this.state;
  }

  setState(
    patch:
      | Partial<EngineState>
      | ((prev: EngineState) => Partial<EngineState> | EngineState),
  ): EngineState {
    const nextPatch = typeof patch === "function" ? patch(this.state) : patch;
    this.state = {
      ...this.state,
      ...nextPatch,
      updatedAt: nowIso(),
    };
    return this.state;
  }
}

export function setState(
  store: StateStore,
  patch:
    | Partial<EngineState>
    | ((prev: EngineState) => Partial<EngineState> | EngineState),
): EngineState {
  return store.setState(patch);
}
