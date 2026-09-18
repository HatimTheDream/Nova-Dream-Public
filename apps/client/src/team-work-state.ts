import { teamRoles, type TeamWork } from '../../../packages/domain/team-work';

type TeamRole = typeof teamRoles[number];
type Member = { id: string; value: { position: string; archived?: boolean } };
const roleTitles: Record<TeamRole, RegExp> = {
  research: /\b(?:research\w*|analyst|investigat\w*)\b/i,
  build: /\b(?:maker|build\w*|develop\w*|engineer\w*|implement\w*)\b/i,
  review: /\b(?:review\w*|quality|verif\w*|test\w*)\b/i,
};

/** Reserve specialists before considering a generalist for the only remaining gap. */
export function suggestedTeamMembers(agents: readonly Member[]): { role: TeamRole; agentId: string }[] {
  const members = agents.filter(agent => !agent.value.archived).map(agent => ({
    id: agent.id, roles: teamRoles.filter(role => roleTitles[role].test(agent.value.position)),
  }));
  const choices = teamRoles.map(role => {
    const candidates = members.filter(member => member.roles.includes(role));
    return { role, candidates, agentId: candidates.length === 1 && candidates[0].roles.length === 1 ? candidates[0].id : '' };
  });
  const gaps = choices.filter(choice => !choice.candidates.length);
  const generalists = members.filter(member => !member.roles.length);
  // Several possible members or roles require an explicit owner choice. Members
  // with competing/multiple role matches stay reserved, never becoming fallback.
  if (gaps.length === 1 && generalists.length === 1) gaps[0].agentId = generalists[0].id;
  return choices.map(({ role, agentId }) => ({ role, agentId }));
}

export type TeamWorkStatus = { runs: TeamWork[]; readError: string; actionError: string };
export type TeamWorkStatusEvent =
  | { type: 'read'; runs: TeamWork[] }
  | { type: 'readError' | 'actionError'; message: string };

export function teamWorkStatus(state: TeamWorkStatus, event: TeamWorkStatusEvent): TeamWorkStatus {
  if (event.type === 'read') return { ...state, runs: event.runs, readError: '' };
  return { ...state, [event.type]: event.message };
}
