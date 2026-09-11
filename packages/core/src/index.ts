export const CORE_VERSION = '0.1.0';
export * from './types.ts';
export {
  parseWorkflow, validateWorkflowSemantics, validateWorkflowWarnings, WorkflowError, stepSchema, workflowSchema,
} from './schema.ts';
export {
  isAgentStep, isCommandStep, isManualStep, isLoopStep, isLeafStep,
  flattenSteps, findStep, collectLoops,
} from './steps.ts';
export type { FlatStep } from './steps.ts';
export {
  spawnSpecSchema, whiphandEventSchema, manualRequestSchema, manualResponseSchema,
  manualChoiceSchema, loopFrameSchema, captureSpecSchema, fileCommentSchema,
} from './events.ts';
export { renderTemplate, buildPrompt, inputArtifacts, TemplateError } from './template.ts';
export type { Templated, TemplateScope } from './template.ts';
export {
  AdapterRegistry, validateWorkflowRunners, validateWorkflowFrontend, defaultRegistry,
} from './registry.ts';
export {
  BUILTIN_TOOLS, TOOL_GROUPS, TOOL_GROUP_LABELS, VERSION_RE, PROBE_TIMEOUT_MS,
  detectTools, probeTool, resolveToolTable, parseToolVersion,
} from './tools.ts';
export type { ToolProbe, ToolStatus, DoctorToolsConfig } from './tools.ts';
export type { ToolGroup } from './tool-groups.ts';
export { loadDoctorConfig, globalDoctorConfigPath, doctorConfigSchema } from './doctor-config.ts';
export { claudeAdapter, CLAUDE_WRITE_TOOLS, CLAUDE_QUIT_SEQUENCE } from './adapters/claude.ts';
export { copilotAdapter, transcriptPath, COPILOT_QUIT_SEQUENCE } from './adapters/copilot.ts';
export {
  loadWorkspaceConfig, loadConfigLayer, loadGlobalConfig, mergeConfig, diffConfigLayer,
  DEFAULT_CONFIG, workspaceConfigSchema, partialConfigSchema, CONFIG_KEYS, configKeySchema,
} from './config.ts';
export type { PartialConfig, ConfigKey } from './config.ts';
export { resolveConfigHome, globalWorkflowsDir, globalConfigPath } from './config-home.ts';
export { migrateLegacyStateDirs } from './state-migration.ts';
export { resolveWorkflowPath, parseInputPairs, listWorkflows } from './workspace.ts';
export type { ResolvedWorkflow, WorkflowListEntry } from './workspace.ts';
export { scopeSchema } from './events.ts';
export {
  createRunDir, artifactPath, ensureArtifactDir, assertArtifact, ArtifactError,
} from './engine/artifacts.ts';
export { snapshotTree, diffSnapshots } from './engine/git-guard.ts';
export {
  workingDiffFiles, parseNumstatZ, splitPatch, pairPatches,
  MAX_DIFF_FILES, MAX_PATCH_BYTES, MAX_TOTAL_PATCH_BYTES,
} from './engine/diff.ts';
export type { WorkingDiff, DiffFileEntry, DiffStatus } from './engine/diff.ts';
export {
  parseVerdict, verdictFromExit, verdictFromChoice, VERDICT_INSTRUCTION, DEFAULT_EXPECT_EXIT,
} from './engine/verdict.ts';
export { commandSpec, captureHeader, captureFooter, DEFAULT_SHELL, shellFlags } from './engine/command.ts';
export {
  resolveExecutable, spawnRunner, execRunner, planLaunch, cmdInvocation, msvcrtQuote,
} from './exec.ts';
export type { ResolvedExecutable, ResolveExecutableOpts, CmdInvocation, LaunchPlan } from './exec.ts';
export {
  buildManualRequest, manualChoices, noteArtifact, reviewArtifact, workingDiff, DIFF_LINE_LIMIT,
} from './engine/manual.ts';
export {
  endMarkerName, endMarkerPath, isEndMarkerName, clearEndMarker, sanitizeStepId,
} from './engine/session-end.ts';
export {
  awaitStateName, awaitStatePath, isAwaitStateName, parseAwaitState, clearAwaitState,
} from './engine/await-state.ts';
export type { AwaitReason, AwaitParse } from './engine/await-state.ts';
export { interactiveGuidance } from './engine/interactive-guidance.ts';
export { runWorkflow } from './engine/runner.ts';
export type { RunOptions, RunResult } from './engine/runner.ts';
export {
  RunJournal, listRuns, getRun, renameRun, isSafeRunId, MANIFEST_VERSION,
} from './engine/manifest.ts';
export type {
  RunManifest, RunSummary, RunDetail, RenameRunResult,
} from './engine/manifest.ts';
export { LOCK_MARKER_NAME, lockPath, isRunLocked, setRunLocked } from './engine/run-lock.ts';
export {
  NAME_MARKER_NAME, SUGGEST_CAPTURE_NAME, RUN_NAME_MAX, RUN_SLUG_MAX, namePath,
  readRunName, setRunName, normalizeRunName, slugifyRunName, runSlugFor,
} from './engine/run-name.ts';
export { autoNameRun, suggestNamePrompt, SUGGEST_TIMEOUT_MS } from './engine/auto-name.ts';
export type { AutoNameOptions } from './engine/auto-name.ts';
export { deleteRun, pruneRuns } from './engine/retention.ts';
export type { DeleteRunReason, DeleteRunResult, PruneRunsResult } from './engine/retention.ts';
// isSafeRunId is already re-exported above, alongside the journal.
export { executionKey, WORKFLOW_SNAPSHOT_NAME } from './engine/manifest.ts';
export { planResume, ResumeError } from './engine/resume.ts';
export type { ResumePlan, DoneExecution } from './engine/resume.ts';
export { initWorkspace, createWorkflow, updateWorkflow, workflowTemplate, WORKFLOW_NAME_RE } from './scaffold.ts';
export {
  isEnabled, disabledRoots, disabledIds, pruneDisabled, droppedRefs, droppedRefSentence, untilTargetOf,
} from './enabled.ts';
export type { DroppedRef } from './enabled.ts';
export {
  ATTACHMENTS_REF, consumesAttachments, unusedAttachmentsMessage, sanitizeAttachmentName, attachmentNames,
} from './attachments.ts';
export {
  ATTACHMENTS_DIR, AttachmentError, validateAttachments, copyAttachments, formatBytes,
} from './engine/attachments.ts';
export type { PlannedAttachment } from './engine/attachments.ts';
export { mergeWorkflow } from './workflow-write.ts';
