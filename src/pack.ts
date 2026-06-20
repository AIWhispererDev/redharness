import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { QaPack } from './types.js';

const severitySchema = z.enum(['Blocker', 'Major', 'Minor', 'Polish']);

const packSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().optional(),
  baseUrl: z.string().optional(),
  issueTypes: z.array(z.string()).default([]),
  severities: z.record(severitySchema, z.string()),
  bounty: z.record(severitySchema, z.string()).optional(),
  tracks: z.record(
    z.string(),
    z.object({
      tasks: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          mapsTo: z.string(),
        }),
      ),
    }),
  ),
  reports: z.record(
    z.string(),
    z.object({
      title: z.string(),
      requiredFields: z.array(z.string()),
      aiQualityTypes: z.array(z.string()).optional(),
      template: z.string().optional(),
    }),
  ),
  rules: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      type: z.literal('text'),
      target: z.string(),
      pattern: z.string().optional(),
      patterns: z.array(z.string()).optional(),
      issueType: z.string().optional(),
      severity: severitySchema,
    }),
  ),
  smoke: z
    .object({
      publicRoutes: z.array(
        z.object({
          path: z.string(),
          titleIncludes: z.string().optional(),
          textIncludes: z.array(z.string()).optional(),
        }),
      ),
    })
    .optional(),
  browserSmoke: z
    .object({
      earlyAccess: z.object({
        path: z.string(),
        requiredModalTexts: z.array(z.string()),
        requiredCheckboxCount: z.number().int().positive(),
        blankInviteExpectedText: z.string(),
      }),
    })
    .optional(),
  profiles: z
    .record(
      z.string(),
      z.object({
        includeTags: z.array(z.string()),
        excludeTags: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

export async function loadPackFromDir(packDir: string): Promise<QaPack> {
  const manifestPath = path.join(packDir, 'pack.yaml');
  const raw = await readFile(manifestPath, 'utf8');
  const parsed = YAML.parse(raw);
  return packSchema.parse(parsed) as QaPack;
}
