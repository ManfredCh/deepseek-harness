/** Model-visible continuation prompt for one same-session goal round. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { GoalView } from '@deepseek-ai/dsh-goal'

/**
 * Render the complete goal-round instruction retained in session history.
 * @param goal - exact active goal revision being admitted.
 * @param round - next positive round number.
 * @returns a fresh one-block prompt for `Agent.followup()`.
 */
export function renderGoalRoundPrompt(goal: GoalView, round: number): ContentBlock[] {
  return [{
    type: 'text',
    text: '<goal_round>\n'
      + `Objective: ${JSON.stringify(goal.objective)}\n`
      + `Round: ${round}/${goal.maxGoalRounds}\n\n`
      + 'Continue working toward the objective in this same session. Treat the current workspace, '
      + 'tool results, and durable session state as authoritative; inspect them instead of assuming '
      + 'earlier narration is still current. Make concrete progress and verify the result.\n'
      + 'Keep the objective intact: never redefine success around a smaller or easier task because it '
      + 'is more likely to pass current tests. An edit is aligned only when it makes the requested '
      + 'final state more true.\n'
      + 'Before claiming completion, gather evidence that the whole objective is achieved, read the '
      + 'current goal, and mark it complete. Only mark it complete when that evidence proves every '
      + 'requirement is satisfied; a plausible summary, intent, or partial progress is not proof. If '
      + 'evidence is weak, indirect, or merely consistent with completion, keep working.\n'
      + 'If work remains, leave the goal active for the next round. Follow the configured goal-tool '
      + 'policy before reporting a blocker; difficulty, slowness, uncertainty, or a wish for '
      + 'clarification is not a blocker.\n'
      + '</goal_round>',
  }]
}
