import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Guards against the secret scan silently going vacuous again.
 *
 * TruffleHog receives an explicit `base`, which on a pull request is the base branch's commit and on a push is
 * `github.event.before`. The pnpm-setup composite action checks the repository out itself, and it fetches only a
 * single commit unless told otherwise — so that base commit is not in the checkout and TruffleHog has nothing to
 * diff. Fetching the full history is what makes the scan real.
 */
const WORKFLOW_PATH = path.resolve(__dirname, '../../.github/workflows/publish.yml');

/** Indentation of a job key (`  Validate-Secrets:`) and of a step (`      - name: ...`) in this workflow. */
const JOB_INDENT = 2;
const STEP_INDENT = 6;

function readWorkflow(): string {
  return readFileSync(WORKFLOW_PATH, 'utf8');
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The lines of a top-level job, up to the next job. */
function readJob(workflow: string, jobName: string): string[] {
  const lines = workflow.split('\n');
  const start = lines.findIndex(line => indentOf(line) === JOB_INDENT && line.trim() === `${jobName}:`);
  if (start < 0) throw new Error(`Job '${jobName}' not found in ${WORKFLOW_PATH}`);

  return readBlock(lines, start + 1, JOB_INDENT);
}

/** The lines of a named step inside a job. */
function readStep(jobLines: string[], stepName: string): string[] {
  const start = jobLines.findIndex(line => indentOf(line) === STEP_INDENT && line.trim() === `- name: ${stepName}`);
  if (start < 0) throw new Error(`Step '${stepName}' not found in job ${WORKFLOW_PATH}`);

  return readBlock(jobLines, start + 1, STEP_INDENT);
}

/** Everything after `startIndex` until a non-blank line indented at or above `indent`. */
function readBlock(lines: string[], startIndex: number, indent: number): string[] {
  const block: string[] = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() !== '' && indentOf(line) <= indent) break;
    block.push(line);
  }
  return block;
}

/** The value of a `name: value` line inside a step, with any YAML quotes removed. */
function readInput(stepLines: string[], inputName: string): string | undefined {
  const line = stepLines.find(candidate => candidate.trim().startsWith(`${inputName}:`));
  if (line == null) return undefined;

  return line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '');
}

describe('secret detection workflow', () => {
  it('fetches the full history for the job that runs TruffleHog', () => {
    const job = readJob(readWorkflow(), 'Validate-Secrets');
    const setupStep = readStep(job, 'Setup pnpm, node, and install');

    expect(readInput(setupStep, 'fetch-depth')).toBe('0');
  });

  it('scans the push range with TruffleHog and only fails on verified secrets', () => {
    const job = readJob(readWorkflow(), 'Validate-Secrets');
    const scanStep = readStep(job, 'Secret detection (TruffleHog)');
    const scan = scanStep.join('\n');

    expect(scan).toContain('uses: trufflesecurity/trufflehog@main');
    expect(readInput(scanStep, 'base')).toBeTruthy();
    expect(readInput(scanStep, 'head')).toBe('HEAD');
    expect(readInput(scanStep, 'extra_args')).toBe('--only-verified');
  });

  it('runs on pull requests, where the base commit is the scanned range', () => {
    const workflow = readWorkflow();
    const pullRequestTrigger = workflow.split('\n').find(line => line.trim() === 'pull_request:');

    expect(pullRequestTrigger).toBeDefined();
  });
});
