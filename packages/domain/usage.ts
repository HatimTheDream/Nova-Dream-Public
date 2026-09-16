export type UsageWindow = { label: string; usedPercent: number | null; resetAt: number | null };
export type ProviderUsage = { provider: string; name: string; plan: string | null; windows: UsageWindow[]; unavailable: boolean; credits: number | null };
export type UsageState = {
  checkedAt: number; reportedAt: number | null; state: 'ready' | 'unavailable' | 'refreshing';
  providers: ProviderUsage[];
  activity: { tokens: number | null; input: number | null; output: number | null; cacheRead: number | null; daily: { date: string; tokens: number | null }[]; status: 'ready' | 'partial' | 'unavailable' };
};
