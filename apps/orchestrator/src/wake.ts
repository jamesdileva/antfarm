export interface WakeInput {
  /** driver still has scripted work (fake) or is due for an idle cycle */
  pendingWork: boolean;
  /** unread queued mail exists for this agent */
  queuedMail: number;
  /** the agent's owned task changed state since its last cycle */
  ownedTaskChanged: boolean;
  /** new commits landed in /workspace since last cycle */
  workspaceChanged: boolean;
}

/**
 * Wake policy v1: an agent wakes when there is anything actionable.
 * Pure function — trivially testable, grows with the platform.
 */
export function shouldWake(input: WakeInput): boolean {
  return input.pendingWork || input.queuedMail > 0 || input.ownedTaskChanged || input.workspaceChanged;
}
