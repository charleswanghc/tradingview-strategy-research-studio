import { z } from 'zod';
import { contextSchema } from './protocol.js';

const date = z.iso.date();
export const periodSchema = z.object({ start: date, end: date })
  .refine(p => p.start < p.end, 'The testing start date must be earlier than the end date.');
export const researchStartSchema = z.object({
  tabId: z.number().int().positive(), expectedContext: contextSchema,
  period: periodSchema, goal: z.string().min(1).max(5000),
  maxRounds: z.number().int().min(1).max(20).default(3),
  timeoutMs: z.number().int().min(30000).max(600000).default(180000),
  exportXlsx: z.boolean().default(true),
  parameters: z.record(z.string().min(1).max(200), z.union([z.number().finite(),z.boolean(),z.string().max(300)])).default({})
    .refine(v => Object.keys(v).length <= 20, 'At most 20 parameter values.'),
  timezone: z.string().min(1).max(100).optional()
});
export const sessionSchema = z.object({ sessionId: z.uuid() });
export const revisionSchema = sessionSchema.extend({ source: z.string().min(1).max(200000), rationale: z.string().min(1).max(10000) });
export const reviewSchema = sessionSchema.extend({ round: z.number().int().positive(), analysis: z.string().min(1).max(50000), decision: z.enum(['continue', 'finish']) });
export const artifactSchema = sessionSchema.extend({
  round: z.number().int().min(0), artifact: z.enum(['source', 'analysis', 'metadata', 'trades']),
  offset: z.number().int().min(0).max(2000000).default(0), limit: z.number().int().min(1).max(100).default(25)
});

export function strategyTitle(source: string): string {
  const withoutComments = source.replace(/\/\/[^\n]*/g, '');
  if (!/^\s*\/\/@version=(5|6)\s*$/m.test(source)) throw new Error('Use Pine Script version 5 or 6.');
  const declaration = /^\s*strategy\s*\(\s*(?:title\s*=\s*)?(["'])([^"'\r\n]{1,200})\1/m.exec(withoutComments);
  if (!declaration) throw new Error('The strategy must declare a constant title with strategy("Title", ...).');
  return declaration[2];
}
