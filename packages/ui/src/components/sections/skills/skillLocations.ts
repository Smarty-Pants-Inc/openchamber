import type { SkillScope, SkillSource } from '@/stores/useSkillsStore';

export type SkillLocationValue = 'user-opencode' | 'project-opencode' | 'user-claude' | 'project-claude' | 'user-agents' | 'project-agents';

export const SKILL_LOCATION_OPTIONS: Array<{
  value: SkillLocationValue;
  scope: SkillScope;
  source: SkillSource;
}> = [
  {
    value: 'user-opencode',
    scope: 'user',
    source: 'opencode',
  },
  {
    value: 'project-opencode',
    scope: 'project',
    source: 'opencode',
  },
  {
    value: 'user-agents',
    scope: 'user',
    source: 'agents',
  },
  {
    value: 'project-agents',
    scope: 'project',
    source: 'agents',
  },
];

export function locationValueFrom(scope: SkillScope, source: SkillSource): SkillLocationValue {
  if (scope === 'project' && source === 'claude') return 'project-claude';
  if (scope === 'project' && source === 'agents') return 'project-agents';
  if (source === 'claude') return 'user-claude';
  if (scope === 'project') return 'project-opencode';
  if (source === 'agents') return 'user-agents';
  return 'user-opencode';
}

export function locationPartsFrom(value: SkillLocationValue): { scope: SkillScope; source: SkillSource } {
  if (value === 'user-claude') return { scope: 'user', source: 'claude' };
  if (value === 'project-claude') return { scope: 'project', source: 'claude' };
  const match = SKILL_LOCATION_OPTIONS.find((option) => option.value === value);
  if (!match) {
    return { scope: 'user', source: 'opencode' };
  }
  return { scope: match.scope, source: match.source };
}
