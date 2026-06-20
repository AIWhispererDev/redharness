/**
 * PRD 05: OWASP Agentic Top 10 mapping — provides metadata and
 * descriptions for each security category.
 */

import type { OwaspCategory } from './redteamTypes.js';

export type OwaspCategoryInfo = {
  id: OwaspCategory;
  name: string;
  description: string;
  typicalImpact: string;
  initialReleaseReady: boolean;
};

export const OWASP_CATEGORIES: Record<OwaspCategory, OwaspCategoryInfo> = {
  ASI01: {
    id: 'ASI01',
    name: 'Agent Goal Hijack',
    description: 'Attacker manipulates the agent\'s goal through direct prompt override, indirect injection in page/document/tool output, delayed/scheduled instruction, or conflicting instructions.',
    typicalImpact: 'Agent performs actions against user intent or discloses protected information.',
    initialReleaseReady: true,
  },
  ASI02: {
    id: 'ASI02',
    name: 'Tool Misuse and Exploitation',
    description: 'Attacker causes the agent to misuse tools through unsafe chaining, excessive/repeated calls, argument injection, exfiltration, or impersonation.',
    typicalImpact: 'Resource exhaustion, data exfiltration, unauthorized state changes.',
    initialReleaseReady: true,
  },
  ASI03: {
    id: 'ASI03',
    name: 'Identity and Privilege Abuse',
    description: 'Attacker exploits cross-user access, inherited privileged sessions, role confusion, or stale credentials.',
    typicalImpact: 'Unauthorized access to other users\' data or elevated privileges.',
    initialReleaseReady: true,
  },
  ASI04: {
    id: 'ASI04',
    name: 'Agentic Supply Chain',
    description: 'Attacker compromises the agent through poisoned tool descriptions/schemas, changed MCP/tool versions, malicious prompt/template dependencies, or unsigned packages.',
    typicalImpact: 'Agent executes attacker-controlled logic through trusted channels.',
    initialReleaseReady: false,
  },
  ASI05: {
    id: 'ASI05',
    name: 'Unexpected Code Execution',
    description: 'Attacker causes command-like content to reach an execution sink, unsafe URL/file handling, or script payload in tool output.',
    typicalImpact: 'Remote code execution or unintended computation.',
    initialReleaseReady: false,
  },
  ASI06: {
    id: 'ASI06',
    name: 'Memory and Context Poisoning',
    description: 'Attacker plants persistent malicious memory, poisons retrieved context, causes cross-session contamination, or extracts memory contents.',
    typicalImpact: 'Persistent agent compromise, data leakage across sessions.',
    initialReleaseReady: true,
  },
  ASI07: {
    id: 'ASI07',
    name: 'Insecure Inter-Agent Communication',
    description: 'Attacker forges sender identity, sends malformed messages, causes instruction/data confusion, or performs unauthorized delegation between agents.',
    typicalImpact: 'Agent-to-agent attack propagation, unauthorized delegation.',
    initialReleaseReady: false,
  },
  ASI08: {
    id: 'ASI08',
    name: 'Cascading Failures',
    description: 'Tool outage, repeated retry amplification, partial-state failure, downstream bad data propagation, or missing circuit-breaker logic.',
    typicalImpact: 'Widespread service degradation, data corruption, resource exhaustion.',
    initialReleaseReady: true,
  },
  ASI09: {
    id: 'ASI09',
    name: 'Human-Agent Trust Exploitation',
    description: 'Attacker exploits fabricated confidence, misleading approval requests, concealed high-impact actions, or social-engineering text presented as system authority.',
    typicalImpact: 'Human operator approves harmful actions based on misleading agent output.',
    initialReleaseReady: true,
  },
  ASI10: {
    id: 'ASI10',
    name: 'Rogue Agents',
    description: 'Self-expanded scope, ignored cancellation, persistent action after goal completion, hidden subgoals, or unauthorized tool discovery.',
    typicalImpact: 'Agent acts outside its authorized scope and control boundaries.',
    initialReleaseReady: true,
  },
};

/**
 * Get all OWASP categories that are ready for initial release.
 */
export function getInitialReleaseCategories(): OwaspCategoryInfo[] {
  return Object.values(OWASP_CATEGORIES).filter((c) => c.initialReleaseReady);
}

/**
 * Get the label/name for a category.
 */
export function getCategoryLabel(category: OwaspCategory): string {
  return OWASP_CATEGORIES[category]?.name ?? category;
}

/**
 * Get the full description for a category.
 */
export function getCategoryDescription(category: OwaspCategory): string {
  return OWASP_CATEGORIES[category]?.description ?? '';
}
