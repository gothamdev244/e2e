import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runsFromCheckout } from '../../src/telemetry/checkout.ts';
import { runCompletedEvent, type RunContext } from '../../src/telemetry/events.ts';
import { postBatch } from '../../src/telemetry/posthog.ts';
import { collectEnvironment, fleetName, statedIdentity } from '../../src/telemetry/environment.ts';
import { Telemetry, type TelemetryOptions } from '../../src/telemetry/telemetry.ts';
import { sampleReport } from '../helpers/sample-report.ts';

const temporaries: string[] = [];
const RUN: RunContext = { command: 'run', flags: [], config: undefined };

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-telemetry-'));
  temporaries.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface SentBatch {
  readonly url: string;
  readonly body: {
    readonly api_key: string;
    readonly batch: readonly {
      readonly event: string;
      readonly timestamp: string;
      readonly properties: Record<string, unknown>;
    }[];
  };
}

/** A fetch that records every request and answers with `status`; like the real one, it refuses an aborted signal. */
function recordingFetch(status = 200): { calls: SentBatch[]; fetch: typeof fetch } {
  const calls: SentBatch[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.signal?.aborted) throw init.signal.reason;
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as SentBatch['body'] });
    return new Response(null, { status });
  }) as typeof fetch;
  return { calls, fetch: impl };
}

function create(overrides: Partial<TelemetryOptions> = {}) {
  const output: string[] = [];
  const sent = recordingFetch();
  const configDir = overrides.configDir ?? tempDir();
  const telemetry = new Telemetry({
    version: '1.2.3',
    env: {},
    cwd: tempDir(),
    configDir,
    fetch: sent.fetch,
    write: (text) => void output.push(text),
    ...overrides,
  });
  return { telemetry, output, sent, configDir };
}

describe('Telemetry, removed from this build', () => {
  const OPT_IN_ENVS: NodeJS.ProcessEnv[] = [
    {},
    { E2E_TELEMETRY_DISABLED: '0', DO_NOT_TRACK: 'false' },
    { CI: '1', CLAUDECODE: '1' },
    { E2E_TELEMETRY_FLEET: 'acme' },
    { E2E_TELEMETRY_DEBUG: '1' },
  ];

  it('is off under every environment, names the build as the reason, and has no identity', () => {
    for (const env of OPT_IN_ENVS) {
      const { telemetry } = create({ env });
      expect(telemetry.enabled).toBe(false);
      expect(telemetry.disabledBy).toBe('build');
      expect(telemetry.distinctId).toBeUndefined();
    }
  });

  it('prints no notice, writes no preferences, and makes no request for a full invocation', async () => {
    for (const env of OPT_IN_ENVS) {
      const { telemetry, output, sent, configDir } = create({ env });
      telemetry.notice();
      telemetry.session('run', ['--headed']);
      telemetry.record(runCompletedEvent(sampleReport(), RUN));
      await telemetry.sendQueued();
      telemetry.endSession(1);
      await telemetry.flush();
      expect(output.filter((text) => !text.startsWith('[telemetry] '))).toEqual([]);
      expect(sent.calls).toEqual([]);
      expect(existsSync(path.join(configDir, 'telemetry.json'))).toBe(false);
    }
  });

  it('stays off after an explicit enable', async () => {
    const { telemetry, sent } = create();
    telemetry.setEnabled(true);
    expect(telemetry.enabled).toBe(false);
    telemetry.session('run', []);
    await telemetry.flush();
    expect(sent.calls).toEqual([]);
  });

  it('never calls fetch from the transport', async () => {
    const sent = recordingFetch();
    const event = { event: 'x', timestamp: new Date().toISOString(), properties: { distinct_id: 'id' } };
    expect(await postBatch([event], { signal: AbortSignal.timeout(1_000), fetch: sent.fetch })).toBe(false);
    expect(sent.calls).toEqual([]);
  });

  it('reads the fleet name as a plain token and a blank variable as unset', () => {
    expect(fleetName({ E2E_TELEMETRY_FLEET: ' ' })).toBeNull();
    expect(fleetName({ E2E_TELEMETRY_FLEET: 'Cloud_Sandbox.v2' })).toBe('Cloud_Sandbox.v2');
    expect(statedIdentity({ E2E_TELEMETRY_FLEET: 'acme' })).toBe('fleet:acme');
    expect(statedIdentity({ CI: '1' })).toBe('ci:unknown');
    expect(statedIdentity({ CI: 'true', GITHUB_ACTIONS: 'true' })).toBe('ci:github-actions');
    // A vendor marker without CI is a shell on a runner, not a run: the machine stays the unit.
    expect(statedIdentity({ GITHUB_ACTIONS: 'true' })).toBeUndefined();
    expect(statedIdentity({})).toBeUndefined();
  });

  it('names the sandbox the kernel announces and the runtime the CLI runs under', () => {
    const cwd = tempDir();
    const local = collectEnvironment({ env: {}, cwd, version: '1.2.3' });
    expect(local.runtime).toBe('node');
    expect(local.runtime_version).toBe(process.versions.node);

    const sandboxed = collectEnvironment({
      env: {},
      cwd,
      version: '1.2.3',
      host: { release: '6.18.36-cloudflare-firecracker-2026.6.17', versions: { ...process.versions, bun: '1.3.9', node: '24.20.0' } },
    });
    expect(sandboxed.sandbox).toBe('firecracker');
    expect(sandboxed.runtime).toBe('bun');
    expect(sandboxed.runtime_version).toBe('1.3.9');
    expect(sandboxed.node_version).toBe('24.20.0');
    expect(collectEnvironment({ env: {}, cwd, version: '1.2.3', host: { release: '25.6.0', versions: process.versions } }).sandbox).toBeNull();
  });
});

describe('runsFromCheckout', () => {
  it('is true only where the CLI source sits beside the build: this repository, not an install or an unpacked package', () => {
    // The real thing: this test runs from the checkout, whose src/cli/index.ts is two directories up from dist/cli or src/cli.
    expect(runsFromCheckout(new URL('../../dist/cli/index.js', import.meta.url).href)).toBe(true);
    expect(runsFromCheckout(new URL('../../src/cli/index.ts', import.meta.url).href)).toBe(true);
    // A package installed under node_modules, or unpacked anywhere else, ships dist without src.
    const root = tempDir();
    for (const packageDir of ['node_modules/e2e', 'node_modules/.pnpm/e2e@0.15.0/node_modules/e2e', 'opt/e2e']) {
      const dist = path.join(root, packageDir, 'dist', 'cli');
      mkdirSync(dist, { recursive: true });
      writeFileSync(path.join(dist, 'index.js'), '', 'utf8');
      expect(runsFromCheckout(pathToFileURL(path.join(dist, 'index.js')).href)).toBe(false);
    }
    // The same layout with the source beside it is a checkout, wherever it lives.
    mkdirSync(path.join(root, 'opt', 'e2e', 'src', 'cli'), { recursive: true });
    writeFileSync(path.join(root, 'opt', 'e2e', 'src', 'cli', 'index.ts'), '', 'utf8');
    expect(runsFromCheckout(pathToFileURL(path.join(root, 'opt', 'e2e', 'dist', 'cli', 'index.js')).href)).toBe(true);
    expect(runsFromCheckout('data:text/javascript,export%20default%201')).toBe(false);
  });
});
