export type Severity = 'Blocker' | 'Major' | 'Minor' | 'Polish';

export type TextRule = {
  id: string;
  label: string;
  type: 'text';
  target: string;
  pattern?: string;
  patterns?: string[];
  issueType?: string;
  severity: Severity;
};

export type QaTask = {
  id: string;
  name: string;
  mapsTo: string;
};

export type QaTrack = {
  tasks: QaTask[];
};

export type QaReportSchema = {
  title: string;
  requiredFields: string[];
  aiQualityTypes?: string[];
  template?: string;
};

export type PublicSmokeRoute = {
  path: string;
  titleIncludes?: string;
  textIncludes?: string[];
};

export type BrowserSmokeConfig = {
  earlyAccess: {
    path: string;
    requiredModalTexts: string[];
    requiredCheckboxCount: number;
    blankInviteExpectedText: string;
  };
};

export type QaPack = {
  id: string;
  name: string;
  type?: string;
  baseUrl?: string;
  issueTypes: string[];
  severities: Record<Severity, string>;
  bounty?: Record<Severity, string>;
  tracks: Record<string, QaTrack>;
  reports: Record<string, QaReportSchema>;
  rules: TextRule[];
  smoke?: {
    publicRoutes: PublicSmokeRoute[];
  };
  browserSmoke?: BrowserSmokeConfig;
};

export type BrowserSmokeCheck = {
  name: string;
  ok: boolean;
  details: string[];
};

export type BrowserSmokeResult = {
  ok: boolean;
  checks: BrowserSmokeCheck[];
  artifacts: string[];
};

export type SmokeResult = {
  name: string;
  ok: boolean;
  details: string[];
};

export type SmokeSummary = {
  ok: boolean;
  total: number;
  passed: number;
  failed: number;
};

export type Finding = {
  ruleId: string;
  label: string;
  severity: Severity;
  issueType?: string;
  match: string;
};

export type ReportData = Record<string, unknown>;

export type ValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  markdown: string;
};

// ---------------------------------------------------------------------------
// Profile definitions (may live in pack.yaml)
// ---------------------------------------------------------------------------

export type ProfileConfig = {
  includeTags: string[];
  excludeTags?: string[];
};

// ---------------------------------------------------------------------------
// Backward-compatible ExecutionStatus re-export for legacy code
// ---------------------------------------------------------------------------

export type ExecutionStatus = 'passed' | 'failed' | 'skipped' | 'error' | 'cancelled';
export type RequirementPolicy = 'required' | 'optional' | 'informational';

/**
 * Extended QaPack with optional profiles field.
 * This allows packs to declare named profiles inline.
 */
export type QaPackWithProfiles = QaPack & {
  profiles?: Record<string, ProfileConfig>;
};
