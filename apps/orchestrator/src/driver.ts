import type { ActionsOutputT } from './actions.js';

export interface DriverContext {
  agent: string;
  cycle: number;
  /** grounded situation report: mail, board snapshot, recent events */
  situation: string;
}

export interface AgentDriver {
  pending(agent: string): boolean;
  run(ctx: DriverContext): Promise<ActionsOutputT>;
}
