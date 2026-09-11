/**
 * Wire schemas for the types core owns.
 *
 * These used to live in @whiphand/agent as a hand-maintained copy, kept in sync by
 * memory. Step kinds and nested loops made that copy actively dangerous — a
 * missed field silently drops a step's body over the RPC — so the definitions
 * live next to the types they validate and the agent imports them.
 */
import { z } from 'zod';
import type { ManualRequest, WhiphandEvent, Scope, SpawnSpec, StepProgress } from './types.ts';

export const scopeSchema: z.ZodType<Scope> = z.enum(['project', 'global']);

export const stepProgressSchema: z.ZodType<StepProgress> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('tool'), tool: z.string(), target: z.string().optional() }),
  z.object({
    kind: z.literal('usage'),
    turns: z.number().int().optional(),
    costUsd: z.number().optional(),
    premiumRequests: z.number().optional(),
  }),
]);

export const spawnSpecSchema: z.ZodType<SpawnSpec> = z.object({
  argv: z.array(z.string()),
  cwd: z.string(),
  env: z.record(z.string(), z.string()),
  interactive: z.boolean(),
  endSession: z.object({ markerPath: z.string(), quitSequence: z.string() }).optional(),
  awaitState: z.object({ statePath: z.string() }).optional(),
  capture: z.object({ path: z.string() }).optional(),
  progress: z.object({
    format: z.enum(['claude-stream-json', 'copilot-jsonl']),
  }).optional(),
});

export const manualChoiceSchema = z.enum(['continue', 'abort', 'retry']);

export const loopFrameSchema = z.object({
  id: z.string(),
  iteration: z.number().int().positive(),
  maxIterations: z.number().int().positive(),
});

export const captureSpecSchema = z.object({
  kind: z.enum(['note', 'review']),
  label: z.string(),
  requiredFor: z.array(manualChoiceSchema),
  perFile: z.boolean(),
});

export const manualRequestSchema: z.ZodType<ManualRequest> = z.object({
  stepId: z.string(),
  kind: z.enum(['manual', 'approval']),
  title: z.string(),
  instructions: z.string(),
  choices: z.array(manualChoiceSchema),
  capture: captureSpecSchema.optional(),
  context: z.object({
    artifacts: z.array(z.object({ id: z.string(), path: z.string() })),
    diff: z.string().optional(),
  }),
  defaultChoice: z.enum(['continue', 'abort']),
  loop: loopFrameSchema.optional(),
});

export const fileCommentSchema = z.object({ path: z.string(), body: z.string() });

export const manualResponseSchema = z.object({
  choice: manualChoiceSchema,
  note: z.string().optional(),
  comments: z.array(fileCommentSchema).optional(),
});

export const whiphandEventSchema: z.ZodType<WhiphandEvent> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run:start'), runId: z.string(), workflow: z.string(),
    source: scopeSchema.optional(), name: z.string().optional(),
    attachments: z.array(z.object({ name: z.string(), size: z.number().int().nonnegative() })).optional(),
  }),
  z.object({
    type: z.literal('run:resume'), runId: z.string(), workflow: z.string(),
    from: z.string().optional(), name: z.string().optional(),
  }),
  z.object({
    type: z.literal('step:skipped'), stepId: z.string(),
    loopId: z.string().optional(), iteration: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('step:start'), stepId: z.string(),
    kind: z.enum(['agent', 'command', 'manual', 'approval', 'loop']),
    runner: z.string().optional(), model: z.string().optional(),
    mode: z.enum(['interactive', 'headless']).optional(),
    loopId: z.string().optional(), iteration: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('step:spawn'), stepId: z.string(), spec: spawnSpecSchema,
    phase: z.enum(['main', 'harvest']),
  }),
  z.object({ type: z.literal('step:artifact'), stepId: z.string(), path: z.string() }),
  z.object({
    type: z.literal('step:progress'), stepId: z.string(), progress: stepProgressSchema,
  }),
  z.object({ type: z.literal('step:verdict'), stepId: z.string(), verdict: z.enum(['pass', 'fail']) }),
  z.object({ type: z.literal('step:done'), stepId: z.string(), exitCode: z.number() }),
  z.object({ type: z.literal('step:manual'), stepId: z.string(), request: manualRequestSchema }),
  z.object({
    type: z.literal('step:manual-resolved'), stepId: z.string(), choice: manualChoiceSchema,
  }),
  z.object({
    type: z.literal('loop:start'), loopId: z.string(), maxIterations: z.number().int(),
  }),
  z.object({
    type: z.literal('loop:iteration'), loopId: z.string(),
    iteration: z.number().int(), maxIterations: z.number().int(),
  }),
  z.object({
    type: z.literal('loop:done'), loopId: z.string(),
    iterations: z.number().int(), passed: z.boolean(),
  }),
  z.object({ type: z.literal('guard:warning'), message: z.string() }),
  z.object({ type: z.literal('run:done'), runId: z.string(), ok: z.boolean() }),
  z.object({ type: z.literal('run:error'), stepId: z.string().optional(), message: z.string() }),
  z.object({ type: z.literal('run:cancelled'), runId: z.string() }),
]);
