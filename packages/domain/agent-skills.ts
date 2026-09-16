import { z } from 'zod';

const names = z.array(z.string().max(500)).max(200);
// Accept the pinned host's status response, then project only display metadata.
// Paths, installer commands, credentials and arbitrary extra fields stay on host.
export const installedSkillSchema = z.object({
  skillKey: z.string().min(1).max(300), name: z.string().max(300), description: z.string().max(20000), source: z.string().max(200),
  eligible: z.boolean(), disabled: z.boolean(), blockedByAgentFilter: z.boolean().optional(), blockedByAllowlist: z.boolean().optional(),
  modelVisible: z.boolean().optional(), commandVisible: z.boolean().optional(),
  missing: z.object({ bins: names.optional(), anyBins: names.optional(), env: names.optional(), config: names.optional(), os: names.optional() }).optional(),
});
export const installedSkillsSchema = z.object({ skills: z.array(installedSkillSchema).max(5000) });
export type InstalledSkill = z.infer<typeof installedSkillSchema>;
export type InstalledSkills = { observedAt: number; generation: string; nativeAgentId: 'main'; skills: InstalledSkill[] };
export type SkillAvailability = 'available' | 'ready' | 'disabled' | 'restricted' | 'setup' | 'unexposed';
export function skillAvailability(skill: InstalledSkill): { state: SkillAvailability; label: string } {
  if (skill.disabled) return { state: 'disabled', label: 'Disabled on host' };
  if (skill.blockedByAllowlist || skill.blockedByAgentFilter) return { state: 'restricted', label: 'Restricted on host' };
  if (!skill.eligible) return { state: 'setup', label: 'Needs setup' };
  if (skill.modelVisible === false) return { state: 'unexposed', label: skill.commandVisible ? 'Command only' : 'Not exposed to Assistant' };
  if (skill.modelVisible === true) return { state: 'available', label: 'Available to Assistant' };
  return { state: 'ready', label: 'Ready · exposure unreported' };
}
