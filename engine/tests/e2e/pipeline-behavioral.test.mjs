// GAP-06: End-to-End Behavioral Pipeline Test
// Verifies the full state machine lifecycle by calling handlers directly.
// No real Claude subagents — purely deterministic.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

process.env.SDD_SKIP_MAIN = '1';

const { handleGetState, handleTransition, handleEvaluateGate, handleLogEvent,
        handleUpdateTask, handleUpdateFeature, handleAppendSignal } = await import('../../build/handlers.js');
const { handleEmitMetrics, handleGetRunSummary } = await import('../../build/observability.js');
const { handleComputeScore, handleRunRetro } = await import('../../build/metacognition.js');

const FIXTURE_DIR = resolve(import.meta.dirname, '..', 'fixtures', 'sample-project');

describe('Pipeline Behavioral Test', () => {
  let projectPath;
  const featureId = 'test-greeting';
  const runId = 'run-behavioral-001';

  before(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'sdd-behavioral-'));
    // Copy fixture
    cpSync(FIXTURE_DIR, projectPath, { recursive: true });

    // Initialize .sdd/state.json with a feature in draft state
    const sddDir = join(projectPath, '.sdd');
    mkdirSync(sddDir, { recursive: true });

    const state = {
      version: '2.0.0',
      project: 'sample-project',
      initialized_at: new Date().toISOString(),
      active_feature: featureId,
      features: {
        [featureId]: {
          state: 'draft',
          spec_path: `specs/${featureId}/spec.md`,
          transitions: [],
          tasks: {},
          signals: [],
          verification_attempts: 0,
          review_attempts: 0,
          fix_loop_attempts: 0,
          fix_review_attempts: 0,
        },
      },
    };
    writeFileSync(join(sddDir, 'state.json'), JSON.stringify(state, null, 2));

    // Create spec file so gate checks can find it
    const specDir = join(projectPath, 'specs', featureId);
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'spec.md'), [
      '# Greeting Feature',
      '',
      '## Overview',
      'Add a greeting function.',
      '',
      '## Requirements',
      '- Return "Hello, World!"',
      '',
      '## Acceptance',
      '- Unit test passes',
    ].join('\n'));
  });

  after(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  it('should get initial state', async () => {
    const result = await handleGetState({ project_path: projectPath });
    assert.equal(result.version, '2.0.0');
    assert.equal(result.active_feature, featureId);
    assert.equal(result.features[featureId].state, 'draft');
  });

  it('should get feature-specific state', async () => {
    const result = await handleGetState({ project_path: projectPath, feature_id: featureId });
    assert.equal(result.feature_id, featureId);
    assert.equal(result.state, 'draft');
  });

  it('should transition draft -> specified (spec-generator)', async () => {
    const result = await handleTransition({
      project_path: projectPath,
      feature_id: featureId,
      from_state: 'draft',
      to_state: 'specified',
      agent_id: 'spec-generator',
    });
    assert.equal(result.success, true);
    assert.equal(result.new_state, 'specified');
  });

  it('should transition specified -> planned (plan-architect)', async () => {
    const result = await handleTransition({
      project_path: projectPath,
      feature_id: featureId,
      from_state: 'specified',
      to_state: 'planned',
      agent_id: 'plan-architect',
    });
    assert.equal(result.success, true);
    assert.equal(result.new_state, 'planned');
  });

  it('should transition planned -> decomposed (task-decomposer)', async () => {
    const result = await handleTransition({
      project_path: projectPath,
      feature_id: featureId,
      from_state: 'planned',
      to_state: 'decomposed',
      agent_id: 'task-decomposer',
    });
    assert.equal(result.success, true);
    assert.equal(result.new_state, 'decomposed');
  });

  it('should reject decomposed -> implementing with no tasks', async () => {
    const result = await handleTransition({
      project_path: projectPath,
      feature_id: featureId,
      from_state: 'decomposed',
      to_state: 'implementing',
      agent_id: 'implementation-engine',
    });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'PRECONDITION_FAILED');
  });

  it('should add tasks and transition decomposed -> implementing', async () => {
    // Add tasks to state via direct state manipulation
    const statePath = join(projectPath, '.sdd', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    state.features[featureId].tasks = {
      'task-1': { status: 'pending', title: 'Implement greeting function' },
      'task-2': { status: 'pending', title: 'Add unit test' },
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const result = await handleTransition({
      project_path: projectPath,
      feature_id: featureId,
      from_state: 'decomposed',
      to_state: 'implementing',
      agent_id: 'implementation-engine',
    });
    assert.equal(result.success, true);
    assert.equal(result.new_state, 'implementing');
  });

  it('should update task status', async () => {
    const r1 = await handleUpdateTask({
      project_path: projectPath,
      feature_id: featureId,
      task_id: 'task-1',
      status: 'completed',
    });
    assert.equal(r1.updated, true);

    const r2 = await handleUpdateTask({
      project_path: projectPath,
      feature_id: featureId,
      task_id: 'task-2',
      status: 'completed',
    });
    assert.equal(r2.updated, true);
  });

  it('should transition implementing -> verifying (verification-engine)', async () => {
    const result = await handleTransition({
      project_path: projectPath,
      feature_id: featureId,
      from_state: 'implementing',
      to_state: 'verifying',
      agent_id: 'verification-engine',
    });
    assert.equal(result.success, true);
    assert.equal(result.new_state, 'verifying');
  });

  it('should transition verifying -> reviewing (verification-engine)', async () => {
    const result = await handleTransition({
      project_path: projectPath,
      feature_id: featureId,
      from_state: 'verifying',
      to_state: 'reviewing',
      agent_id: 'verification-engine',
    });
    assert.equal(result.success, true);
    assert.equal(result.new_state, 'reviewing');
  });

  it('should transition reviewing -> pr_created (adversarial-reviewer)', async () => {
    const result = await handleTransition({
      project_path: projectPath,
      feature_id: featureId,
      from_state: 'reviewing',
      to_state: 'pr_created',
      agent_id: 'adversarial-reviewer',
    });
    assert.equal(result.success, true);
    assert.equal(result.new_state, 'pr_created');
  });

  it('should reject unauthorized transitions', async () => {
    // Reset to draft for this test by creating a new feature
    const statePath = join(projectPath, '.sdd', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    state.features['test-auth'] = {
      state: 'draft',
      spec_path: 'specs/test-auth/spec.md',
      transitions: [],
      tasks: {},
      signals: [],
      verification_attempts: 0,
      review_attempts: 0,
      fix_loop_attempts: 0,
      fix_review_attempts: 0,
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const result = await handleTransition({
      project_path: projectPath,
      feature_id: 'test-auth',
      from_state: 'draft',
      to_state: 'specified',
      agent_id: 'implementation-engine',
    });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'UNAUTHORIZED');
  });

  it('should block transition when circuit breaker signal is active', async () => {
    // Create a fresh feature for this test
    const cbFeature = 'test-circuit-breaker';
    const statePath = join(projectPath, '.sdd', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    state.features[cbFeature] = {
      state: 'implementing',
      spec_path: `specs/${cbFeature}/spec.md`,
      transitions: [],
      tasks: { 'task-1': { status: 'completed', completed_at: new Date().toISOString() } },
      signals: [{
        id: 'abort-signal-1',
        type: 'ATTENTION_REQUIRED',
        from_agent: 'orchestrator',
        at: new Date().toISOString(),
        payload: { message: 'delta_check returned abort. Fix loop diverging.', circuit_breaker: true },
      }],
      verification_attempts: 0,
      review_attempts: 0,
      fix_loop_attempts: 0,
      fix_review_attempts: 0,
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2));

    const result = await handleTransition({
      project_path: projectPath,
      feature_id: cbFeature,
      from_state: 'implementing',
      to_state: 'verifying',
      agent_id: 'verification-engine',
    });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'CIRCUIT_BREAKER');
    assert.ok(result.error.message.includes('circuit breaker') || result.error.message.includes('Circuit breaker'));
  });

  it('should emit metrics for pipeline phases', async () => {
    const now = new Date().toISOString();
    const phases = ['spec', 'plan', 'decompose', 'implement', 'verify', 'review', 'pr'];

    for (const phase of phases) {
      const metrics = {
        run_id: runId,
        feature_id: featureId,
        phase,
        agent: `${phase}-agent`,
        model: 'sonnet',
        started_at: now,
        completed_at: now,
        duration_ms: 1000 + Math.floor(Math.random() * 5000),
        tokens_in: null,
        tokens_out: null,
        tool_calls_count: 5,
        gate_result: 'pass',
        gate_attempts: 1,
        findings_count: 0,
        findings_severity: [],
        fix_loop_count: 0,
        delta_direction: null,
        feature_type: 'api',
        complexity: 'low',
      };

      const result = await handleEmitMetrics({ project_path: projectPath, metrics });
      assert.equal(result.emitted, true);
      assert.equal(result.phase, phase);
    }
  });

  it('should produce valid run summary', async () => {
    const result = await handleGetRunSummary({
      project_path: projectPath,
      feature_id: featureId,
      run_id: runId,
    });

    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    assert.equal(result.run_id, runId);
    assert.equal(result.feature_id, featureId);
    assert.equal(typeof result.total_duration_ms, 'number');
    assert.ok(result.total_duration_ms > 0);
    assert.ok(Array.isArray(result.phases_executed));
    assert.ok(result.phases_executed.length > 0);
    assert.equal(result.outcome, 'pr_created');
    assert.equal(result.first_pass_rate, 100);
    assert.ok(Array.isArray(result.phase_metrics));

    // Verify summary.json was persisted
    const summaryPath = join(projectPath, '.sdd', 'runs', featureId, 'summary.json');
    assert.ok(existsSync(summaryPath), 'summary.json should be persisted');
  });

  it('should compute pipeline score', async () => {
    const result = await handleComputeScore({
      project_path: projectPath,
      feature_id: featureId,
    });

    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    assert.equal(typeof result.pipeline_score, 'number');
    assert.ok(result.pipeline_score >= 0 && result.pipeline_score <= 100);
    assert.equal(result.feature_id, featureId);
    assert.equal(typeof result.quality_score, 'number');
    assert.equal(typeof result.efficiency_score, 'number');
    assert.ok(result.breakdown);
    assert.ok(result.weights_used);
    assert.ok(result.golden_comparison);
  });

  it('should generate retro report', async () => {
    const result = await handleRunRetro({
      project_path: projectPath,
      feature_id: featureId,
      expected_outcome: 'pr_created',
    });

    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    assert.equal(result.feature_id, featureId);
    assert.equal(result.outcome, 'pr_created');
    assert.ok(Array.isArray(result.phase_breakdown));
    assert.ok(result.phase_breakdown.length > 0);
    assert.ok(Array.isArray(result.bottlenecks));
    assert.ok(Array.isArray(result.suggestions));
    assert.ok(result.expected_vs_actual);
    assert.equal(result.expected_vs_actual.match, true);
    assert.ok(result.generated_at);

    // Verify retro.json was persisted
    const retroPath = join(projectPath, '.sdd', 'runs', featureId, 'retro.json');
    assert.ok(existsSync(retroPath), 'retro.json should be persisted');
  });

  it('should log events', async () => {
    const result = await handleLogEvent({
      project_path: projectPath,
      feature_id: featureId,
      event_type: 'phase_start',
      phase: 'spec',
      agent_id: 'spec-generator',
      data: { message: 'Starting spec generation' },
    });
    assert.equal(result.logged, true);
    assert.ok(result.timestamp);
  });

  it('should append signals', async () => {
    const result = await handleAppendSignal({
      project_path: projectPath,
      feature_id: featureId,
      from_agent: 'verification-engine',
      signal_type: 'QUALITY_CHECK',
      message: 'All tests passing',
      severity: 'info',
    });
    assert.equal(result.appended, true);
    assert.ok(result.signal_id);
    assert.equal(result.in_state, true);
  });

  it('should evaluate gate checks', async () => {
    const result = await handleEvaluateGate({
      phase_id: 'specify',
      project_path: projectPath,
      feature_id: featureId,
      artifacts: { 'spec.md': `specs/${featureId}/spec.md` },
    });

    assert.ok(!result.error, `Unexpected error: ${result.error}`);
    assert.ok(Array.isArray(result.checks));
  });

  it('should verify final feature state is pr_created', async () => {
    const result = await handleGetState({ project_path: projectPath, feature_id: featureId });
    assert.equal(result.state, 'pr_created');
    assert.ok(result.transitions.length >= 7, `Expected >= 7 transitions, got ${result.transitions.length}`);
  });
});
