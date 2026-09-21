import { teamRoles, type TeamWork } from '../../../packages/domain/team-work';
import type { TeamWorkForm } from './team-work-action';

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

/** Explain fresh-start prerequisites without changing a retained request. */
export function teamWorkReadiness(form: TeamWorkForm, projects: readonly { id: string }[], agents: readonly Member[]): string {
  if (!projects.length) return 'Create a Work Project from GitHub or a host folder before starting.';
  if (!form.projectId) return 'Choose a Work Project for this workflow.';
  if (!projects.some(project => project.id === form.projectId)) return 'Your saved project is unavailable for team work. Choose another Work Project; your brief is kept.';
  const active = agents.filter(agent => !agent.value.archived);
  if (active.length < 2) return 'Create or restore at least two agents before starting team work.';
  if (form.steps.some(step => !step.agentId)) return 'Choose an agent for each stage.';
  if (form.steps.some(step => !active.some(agent => agent.id === step.agentId))) return 'A saved team member is unavailable. Choose an active agent for each stage; your brief is kept.';
  if (new Set(form.steps.map(step => step.agentId)).size < 2) return 'Choose at least two different team members.';
  if (!form.title.trim()) return 'Add a title for this workflow.';
  if (!form.brief.trim()) return 'Describe the outcome you want the team to deliver.';
  return '';
}

export type TeamWorkStatus = { runs: TeamWork[]; readError: string; actionError: string };
export type TeamWorkStatusEvent =
  | { type: 'read'; runs: TeamWork[] }
  | { type: 'readError' | 'actionError'; message: string };

export function teamWorkStatus(state: TeamWorkStatus, event: TeamWorkStatusEvent): TeamWorkStatus {
  if (event.type === 'read') return { ...state, runs: event.runs, readError: '' };
  return { ...state, [event.type]: event.message };
}
