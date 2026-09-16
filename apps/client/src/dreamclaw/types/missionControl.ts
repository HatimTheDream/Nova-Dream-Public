export type MissionControlPageKey =
  | 'home'
  | 'chat'
  | 'inbox'
  | 'tasks'
  | 'content'
  | 'approvals'
  | 'council'
  | 'projects'
  | 'memory'
  | 'docs'
  | 'people'
  | 'office'
  | 'sessions'
  | 'workflow'
  | 'agents'
  | 'calendar'
  | 'ops'
  | 'settings';

export type OpsTab = 'agents' | 'workflows' | 'analytics' | 'terminal' | 'cron' | 'logs' | 'files' | 'sandbox';
export type AgentsTab = 'fleet' | 'live' | 'registry' | 'activity' | 'sessions' | 'memory' | 'labs';
export type SettingsTab = 'assistant' | 'preferences' | 'system' | 'extensions' | 'integrations' | 'phone';

export type ViewDensity = 'comfortable' | 'compact';
export type HealthScope = 'workflow' | 'agent' | 'session' | 'cron' | 'inbox' | 'task';
export type EvidenceType = 'command' | 'citation' | 'browser' | 'screenshot' | 'test' | 'review' | 'artifact';
export type HealthSeverity = 'info' | 'warning' | 'error';
export type KnowledgeQualityState = 'useful' | 'stale' | 'misleading' | 'pending';

export interface PageViewState {
  filter?: string;
  grouping?: string;
  ordering?: string;
  layout?: string;
  density?: ViewDensity;
  activeSavedViewId?: string | null;
  railVisibility?: {
    left?: boolean;
    right?: boolean;
  };
  selectedItemId?: string | null;
  activeTab?: string;
  search?: string;
}

export interface SavedViewRecord {
  id: string;
  page: MissionControlPageKey;
  label: string;
  filters?: Record<string, string | number | boolean | string[]>;
  grouping?: string;
  ordering?: string;
  layout?: string;
  density?: ViewDensity;
  shared: boolean;
  default: boolean;
}
