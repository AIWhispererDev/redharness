/**
 * Harness service — shared types used by both CLI and MCP adapters.
 */

export type PackInfo = {
  id: string;
  name: string;
  baseUrl?: string;
};

export type ServiceError = {
  code: string;
  message: string;
  details?: unknown;
};
