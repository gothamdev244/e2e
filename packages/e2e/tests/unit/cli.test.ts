import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListOptions, ListedPair, RunOptions } from '../../src/run/runner.ts';
import { ConfigurationError } from '../../src/internal/errors.ts';
import { sampleReport } from '../helpers/sample-report.ts';

const runMock = vi.hoisted(() => vi.fn());
const listMock = vi.hoisted(() => vi.fn());
const initMock = vi.hoisted(() => vi.fn());

// The suite runs from the repository; these tests cover an installed CLI, where telemetry is on.
vi.mock('../../src/telemetry/checkout.ts', () => ({ runsFromCheckout: () => false }));
vi.mock('../../src/run/runner.ts', () => ({
  run: runMock,
  list: listMock,
}));
vi.mock('../../src/cli/init.ts', () => ({
  init: initMock,
}));

const { main } = await import('../../src/cli/index.ts');

const { version: packageVersion } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

/** What a mocked `init` hands back: the exit code and the choices, none made. */
function initOutcome(exitCode: number, overrides: Record<string, unknown> = {}) {
  return {
    exitCode,
    result: exitCode === 0 ? 'scaffolded' : 'invalid-project',
    yes: false,
    existingConfig: false,
    engine: null,
    gateway: null,
    skill: false,
    mcp: false,
    install: false,
    ...overrides,
  };
}

function lastRunOptions(): RunOptions {
  expect(runMock).toHaveBeenCalledTimes(1);
  return runMock.mock.calls[0]?.[0] as RunOptions;
}

async function invoke(...args: string[]): Promise<void> {
  await main(['node', 'e2e', ...args]);
}

let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

/** Everything written to a stream so far, with any color stripped. */
function written(spy: ReturnType<typeof vi.spyOn>): string {
  return stripVTControlCharacters(spy.mock.calls.map((call: readonly unknown[]) => String(call[0])).join(''));
}

beforeEach(() => {
  runMock.mockReset();
  runMock.mockResolvedValue({ exitCode: 0, report: sampleReport() });
  listMock.mockReset();
  listMock.mockResolvedValue({ pairs: [] });
  initMock.mockReset();
  initMock.mockResolvedValue(initOutcome(0));
  process.exitCode = undefined;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  process.exitCode = undefined;
});

describe('e2e run argument parsing', () => {
  it('passes defaults through with no flags', async () => {
    await invoke('run');
    const options = lastRunOptions();
    expect(options.files).toEqual([]);
    expect(options.tagMode).toBe('any');
    expect(options.configPath).toBeUndefined();
    expect(options.reporters).toBeUndefined();
    expect(process.exitCode).toBe(0);
  });

  it('collects positional files', async () => {
    await invoke('run', 'tests/a.e2e.ts', 'tests/b.e2e.ts');
    expect(lastRunOptions().files).toEqual(['tests/a.e2e.ts', 'tests/b.e2e.ts']);
  });

  it('rejects a flag that arrived as a file argument with exit code 2 and never runs', async () => {
    await invoke('run', '--', '--headed');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toMatch(
      /^error: "--headed" is a flag, not a test file\. It arrived as a file because a "--" came before it; "(?:pnpm|npm run|yarn|bun run) test:e2e -- --headed" reaches e2e as "run -- --headed" when the package manager forwards the separator\. Run the CLI directly instead: (?:pnpm exec|npm exec|yarn|bun run) e2e run --headed\n\(add --help for usage\)\n$/u,
    );
  });

  it('keeps the whole forwarded tail in the hint, option values and files included', async () => {
    await invoke('run', '--', 'tests/a.e2e.ts', '--tag', 'smoke', 'tests/b.e2e.ts');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toMatch(
      /Run the CLI directly instead: (?:pnpm exec|npm exec|yarn|bun run) e2e run --tag smoke tests\/b\.e2e\.ts\n/u,
    );
  });

  it('passes a dash-prefixed name through when it names an existing file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-cli-dash-'));
    writeFileSync(path.join(dir, '-smoke.e2e.ts'), '');
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      await invoke('run', '--', '-smoke.e2e.ts');
      expect(lastRunOptions().files).toEqual(['-smoke.e2e.ts']);
      expect(process.exitCode).toBe(0);
    } finally {
      cwdSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes --agent through as the agents of the run', async () => {
    await invoke('run', '--agent', 'ux');
    expect(lastRunOptions().agent).toEqual(['ux']);
  });

  it('collects repeated and comma-separated --agent names in order', async () => {
    await invoke('run', '--agent', 'buyer, admin', '--agent', 'guest');
    expect(lastRunOptions().agent).toEqual(['buyer', 'admin', 'guest']);
  });

  it('leaves the agent to the config without --agent', async () => {
    await invoke('run');
    expect(lastRunOptions().agent).toBeUndefined();
  });

  it('splits comma-separated targets, trims whitespace, and accumulates repeats once each', async () => {
    await invoke('run', '--target', 'chromium, firefox , ,webkit', '--target', 'chromium,edge');
    expect(lastRunOptions().targetIds).toEqual(['chromium', 'firefox', 'webkit', 'edge']);
  });

  it('accumulates repeated --tag flags and splits comma-separated tags', async () => {
    await invoke('run', '--tag', 'smoke', '--tag', 'auth, billing');
    expect(lastRunOptions().tags).toEqual(['smoke', 'auth', 'billing']);
  });

  it('rejects an empty --tag, --target, or --agent value with exit code 2 and never runs', async () => {
    const cases = [
      ['--tag <tags>', ''],
      ['--tag <tags>', ' , '],
      ['--target <ids>', ''],
      ['--agent <names>', ' '],
    ] as const;
    for (const [option, value] of cases) {
      const flag = option.split(' ')[0]!;
      stderrSpy.mockClear();
      process.exitCode = undefined;
      await invoke('run', flag, value);
      expect(process.exitCode).toBe(2);
      expect(written(stderrSpy)).toBe(
        `error: option '${option}' argument '${value}' is invalid. must name at least one ${flag.slice(2)}\n(add --help for usage)\n`,
      );
    }
    expect(runMock).not.toHaveBeenCalled();
  });

  it('accumulates --exclude-tag like --tag', async () => {
    await invoke('run', '--tag', 'smoke', '--exclude-tag', 'slow, flaky', '--exclude-tag', 'slow');
    const options = lastRunOptions();
    expect(options.tags).toEqual(['smoke']);
    expect(options.excludeTags).toEqual(['slow', 'flaky']);
  });

  it('compiles --grep and --grep-invert to regular expressions, bare or /pattern/flags, one per repeat', async () => {
    await invoke('run', '--grep', 'checkout', '--grep', '/sign.?in/i', '--grep-invert', 'refund');
    const options = lastRunOptions();
    expect(options.grep).toEqual([/checkout/, /sign.?in/i]);
    expect(options.grepInvert).toEqual([/refund/]);
  });

  it('rejects a --grep that does not compile with exit code 2 and never runs', async () => {
    await invoke('run', '--grep', '(checkout');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toMatch(
      /^error: option '--grep <pattern>' argument '\(checkout' is invalid\. must be a regular expression: Invalid regular expression: .*\n\(add --help for usage\)\n$/u,
    );
    stderrSpy.mockClear();
    process.exitCode = undefined;
    await invoke('run', '--grep-invert', '//');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toBe(
      "error: option '--grep-invert <pattern>' argument '//' is invalid. must be a regular expression\n(add --help for usage)\n",
    );
  });

  it('parses --max-failures as a positive integer and rejects anything else with exit code 2', async () => {
    await invoke('run', '--max-failures', '3');
    expect(lastRunOptions().maxFailures).toBe(3);
    runMock.mockClear();
    for (const value of ['0', '-1', '2.5', 'many']) {
      stderrSpy.mockClear();
      process.exitCode = undefined;
      await invoke('run', '--max-failures', value);
      expect(process.exitCode, value).toBe(2);
      expect(written(stderrSpy)).toBe(
        `error: option '--max-failures <n>' argument '${value}' is invalid. must be a positive integer\n(add --help for usage)\n`,
      );
    }
    expect(runMock).not.toHaveBeenCalled();
  });

  it('parses --repeat-each as a positive integer', async () => {
    await invoke('run', '--repeat-each', '3');
    expect(lastRunOptions().repeatEach).toBe(3);
    runMock.mockClear();
    process.exitCode = undefined;
    await invoke('run', '--repeat-each', '0');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it('parses --shard as index/total and --last-failed as a flag', async () => {
    await invoke('run', '--shard', '2/3', '--last-failed');
    const options = lastRunOptions();
    expect(options.shard).toEqual({ index: 2, total: 3 });
    expect(options.lastFailed).toBe(true);
  });

  it('rejects a --shard that is not index/total within range with exit code 2 and never runs', async () => {
    for (const value of ['0/3', '4/3', '2', 'a/b', '1/0', '-1/2', '1.5/2']) {
      stderrSpy.mockClear();
      process.exitCode = undefined;
      await invoke('run', '--shard', value);
      expect(process.exitCode, value).toBe(2);
      expect(written(stderrSpy)).toBe(
        `error: option '--shard <index/total>' argument '${value}' is invalid. must be index/total, such as 2/3, with the index from 1 through the total\n(add --help for usage)\n`,
      );
    }
    expect(runMock).not.toHaveBeenCalled();
  });

  it('accepts --tag-mode all', async () => {
    await invoke('run', '--tag-mode', 'all');
    expect(lastRunOptions().tagMode).toBe('all');
  });

  it('rejects an invalid --tag-mode with exit code 2 and never runs', async () => {
    await invoke('run', '--tag-mode', 'sometimes');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toBe(
      "error: option '--tag-mode <mode>' argument 'sometimes' is invalid. Allowed choices are any, all.\n(add --help for usage)\n",
    );
  });

  it('parses reporters and rejects unknown reporters with exit code 2', async () => {
    await invoke('run', '--reporter', 'list,json');
    expect(lastRunOptions().reporters).toEqual(['list', 'json']);

    runMock.mockClear();
    process.exitCode = undefined;
    await invoke('run', '--reporter', 'list,teamcity');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toBe(
      "error: option '--reporter <ids>' argument 'list,teamcity' is invalid. unknown reporter \"teamcity\"; expected list, json, junit, markdown\n(add --help for usage)\n",
    );
  });

  it('accepts the junit reporter alone and beside list or json', async () => {
    await invoke('run', '--reporter', 'junit');
    expect(lastRunOptions().reporters).toEqual(['junit']);

    runMock.mockClear();
    await invoke('run', '--reporter', 'list,junit');
    expect(lastRunOptions().reporters).toEqual(['list', 'junit']);

    // Reporter combination rules are config truth (INVALID_CONFIG), not CLI
    // parsing: the CLI only rejects ids it does not know.
    runMock.mockClear();
    await invoke('run', '--reporter', 'junit,json');
    expect(lastRunOptions().reporters).toEqual(['junit', 'json']);
    expect(process.exitCode).toBe(0);
  });

  it('exits 2 on an unknown option or command without running, pointing at --help', async () => {
    await invoke('run', '--nope');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toBe("error: unknown option '--nope'\n(add --help for usage)\n");

    process.exitCode = undefined;
    stderrSpy.mockClear();
    await invoke('frobnicate');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toBe("error: unknown command 'frobnicate'\n(add --help for usage)\n");
  });

  it('parses numeric --retries and --workers', async () => {
    await invoke('run', '--retries', '2', '--workers', '4');
    const options = lastRunOptions();
    expect(options.retries).toBe(2);
    expect(options.workers).toBe(4);
  });

  it('rejects negative and non-integer numeric flags with exit code 2', async () => {
    for (const value of ['-1', '1.5', 'abc']) {
      runMock.mockClear();
      process.exitCode = undefined;
      await invoke('run', '--retries', value);
      expect(runMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
    }
  });

  it('passes boolean and path flags through', async () => {
    await invoke(
      'run',
      '--headed',
      '--debug',
      '--ai-trace',
      '--pass-with-no-tests',
      '--config',
      'custom.config.ts',
      '--output',
      'out',
    );
    const options = lastRunOptions();
    expect(options.headed).toBe(true);
    expect(options.debug).toBe(true);
    expect(options.aiTrace).toBe(true);
    expect(options.passWithNoTests).toBe(true);
    expect(options.configPath).toBe('custom.config.ts');
    expect(options.output).toBe('out');
  });

  it('parses --trace and --video modes, a bare flag as on', async () => {
    await invoke('run', '--trace=on-all-retries', '--video');
    expect(lastRunOptions()).toMatchObject({ trace: 'on-all-retries', video: 'on' });
    runMock.mockClear();
    await invoke('run', '--trace', '--video=retain-on-failure');
    expect(lastRunOptions()).toMatchObject({ trace: 'on', video: 'retain-on-failure' });
    runMock.mockClear();
    await invoke('run', 'tests/a.e2e.ts');
    expect(lastRunOptions()).toMatchObject({ trace: undefined, video: undefined });
  });

  it('refuses a --trace value that is not a mode, with the way to write one', async () => {
    await invoke('run', '--trace', 'tests/a.e2e.ts');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain('write --trace=<mode>, or put test files before --trace');
  });

  it('maps the old --trace spellings to the modes they meant', async () => {
    for (const [value, mode] of [['retries', 'on-all-retries'], ['all', 'on']]) {
      runMock.mockClear();
      process.exitCode = undefined;
      stderrSpy.mockClear();
      await invoke('run', `--trace=${value}`);
      expect(runMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      expect(written(stderrSpy)).toContain(`"${value}" is the old spelling of --trace ${mode}`);
    }
  });

  it('refuses the removed --artifacts, mapping it to --output of its parent', async () => {
    for (const command of ['run', 'explore']) {
      runMock.mockClear();
      process.exitCode = undefined;
      stderrSpy.mockClear();
      await invoke(command, '--artifacts', 'out/artifacts');
      expect(runMock).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      expect(written(stderrSpy)).toContain('--artifacts was removed: write --output out instead');
      expect(written(stderrSpy)).toContain('must be a directory inside the project, not its root');
    }
  });

  it('suggests .e2e for a removed --artifacts whose parent no output can be', async () => {
    for (const value of ['artifacts', './artifacts', '../elsewhere/artifacts', '/abs/artifacts']) {
      process.exitCode = undefined;
      stderrSpy.mockClear();
      await invoke('run', '--artifacts', value);
      expect(process.exitCode).toBe(2);
      expect(written(stderrSpy), value).toContain('--artifacts was removed: write --output .e2e instead');
    }
  });

  it('propagates the run outcome exit code', async () => {
    runMock.mockResolvedValue({ exitCode: 3, report: sampleReport() });
    await invoke('run');
    expect(process.exitCode).toBe(3);
  });

  it('maps unexpected parse failures to exit code 2', async () => {
    await invoke('definitely-not-a-command');
    expect(process.exitCode).toBe(2);
  });

});

describe('e2e list', () => {
  const pairs: ListedPair[] = [
    { file: 'tests/a.e2e.ts', title: 'signs in', titlePath: ['signs in'], kind: 'test', tags: ['smoke', 'auth'], target: 'web', disposition: 'run' },
    {
      file: 'tests/a.e2e.ts',
      title: 'pays',
      titlePath: ['billing', 'pays'],
      kind: 'test',
      tags: ['billing'],
      target: 'web',
      disposition: 'skip',
      skipReason: 'not today',
    },
    { file: 'tests/b.e2e.ts', title: 'browses', titlePath: ['browses'], kind: 'test', tags: [], target: 'webkit', disposition: 'run' },
  ];

  function lastListOptions(): ListOptions {
    expect(listMock).toHaveBeenCalledTimes(1);
    return listMock.mock.calls[0]?.[0] as ListOptions;
  }

  it('prints one line per pair and exits 0 without running', async () => {
    listMock.mockResolvedValue({ pairs });
    await invoke('list');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(written(stdoutSpy)).toBe(
      [
        'tests/a.e2e.ts › signs in [web] #smoke #auth',
        'tests/a.e2e.ts › billing › pays [web] #billing (skipped: not today)',
        'tests/b.e2e.ts › browses [webkit]',
        '',
      ].join('\n'),
    );
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('rejects a flag that arrived as a file argument with exit code 2 and never lists', async () => {
    await invoke('list', '--', '--tag', 'smoke');
    expect(listMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    const stderr = written(stderrSpy);
    expect(stderr.startsWith('error: "--tag" is a flag, not a test file.')).toBe(true);
    expect(stderr).toMatch(/Run the CLI directly instead: (?:pnpm exec|npm exec|yarn|bun run) e2e list --tag smoke\n/u);
    expect(stderr.endsWith('(add --help for usage)\n')).toBe(true);
  });

  it('prints { pairs } with --reporter json', async () => {
    listMock.mockResolvedValue({ pairs });
    await invoke('list', '--reporter', 'json');
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(written(stdoutSpy))).toEqual({ pairs });
  });

  it('passes the selection flags through and rejects the junit reporter', async () => {
    await invoke(
      'list',
      'tests/a.e2e.ts',
      '--config',
      'custom.config.ts',
      '--target',
      'web, webkit',
      '--tag',
      'smoke',
      '--tag',
      'auth',
      '--tag-mode',
      'all',
      '--pass-with-no-tests',
    );
    expect(lastListOptions()).toEqual({
      files: ['tests/a.e2e.ts'],
      configPath: 'custom.config.ts',
      targetIds: ['web', 'webkit'],
      tags: ['smoke', 'auth'],
      tagMode: 'all',
      passWithNoTests: true,
    });
    expect(written(stdoutSpy)).toBe('');

    listMock.mockClear();
    process.exitCode = undefined;
    await invoke('list', '--reporter', 'junit');
    expect(listMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain("option '--reporter <id>' argument 'junit' is invalid");
  });

  it('splits comma-separated --tag and --target values and rejects an empty one, like run', async () => {
    await invoke('list', '--tag', 'smoke,auth', '--tag', 'smoke', '--target', 'web,webkit');
    expect(lastListOptions()).toMatchObject({ tags: ['smoke', 'auth'], targetIds: ['web', 'webkit'] });
    listMock.mockClear();
    process.exitCode = undefined;
    await invoke('list', '--tag', '');
    expect(listMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain("option '--tag <tags>' argument '' is invalid. must name at least one tag");
  });

  it('prints a collection failure as code and message with its exit code', async () => {
    listMock.mockRejectedValue(new ConfigurationError('NO_TESTS', 'no tests matched'));
    await invoke('list');
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(written(stderrSpy)).toBe('NO_TESTS: no tests matched\n');
    expect(process.exitCode).toBe(2);
  });

  it('is listed in the help with an example, and its own help groups the flags', async () => {
    await invoke('--help');
    expect(written(stdoutSpy)).toMatch(/^ {2}list \[options\] \[files\.\.\.\] {2,}print the tests a run would select/mu);
    expect(written(stdoutSpy)).toContain('  $ e2e list --tag smoke\n');

    process.exitCode = undefined;
    stdoutSpy.mockClear();
    await invoke('list', '--help');
    const help = written(stdoutSpy);
    expect(help).toContain('Usage: e2e list [options] [files...]');
    const headings = [...help.matchAll(/^(\S[^\n]*):$/gmu)].map((match) => match[1]);
    expect(headings).toEqual(['Arguments', 'Selection', 'Output', 'Options', 'Examples']);
    const flags = [...help.matchAll(/^ {2}(-{1,2}[a-z-]+)/gmu)].map((match) => match[1]);
    expect(flags).toEqual([
      '--config',
      '--target',
      '--tag',
      '--tag-mode',
      '--exclude-tag',
      '--grep',
      '--grep-invert',
      '--last-failed',
      '--shard',
      '--pass-with-no-tests',
      '--reporter',
      '-h',
    ]);
    expect(help).toContain('  $ e2e list --reporter json\n');
    expect(help).toContain('Docs: https://e2e.tester.army/docs/reference/cli#e2e-list\n');
    expect(process.exitCode).toBe(0);
    expect(listMock).not.toHaveBeenCalled();
  });
});

describe('e2e init argument parsing', () => {
  it('scaffolds the working directory by default and reports the terminal state', async () => {
    await invoke('init', '--yes');
    expect(initMock).toHaveBeenCalledExactlyOnceWith(process.cwd(), {
      yes: true,
      interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    });
    expect(process.exitCode).toBe(0);
  });

  it('resolves a directory argument against the working directory and passes it along as typed', async () => {
    initMock.mockResolvedValue(initOutcome(2));
    await invoke('init', 'apps/web');
    expect(initMock).toHaveBeenCalledExactlyOnceWith(
      path.resolve(process.cwd(), 'apps/web'),
      expect.objectContaining({ directory: 'apps/web' }),
    );
    expect(process.exitCode).toBe(2);
  });

  it('rejects a second positional', async () => {
    await invoke('init', 'one', 'two');
    expect(initMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
});

describe('e2e --version and --help', () => {
  it('prints the package version alone and exits 0', async () => {
    for (const flag of ['--version', '-v']) {
      process.exitCode = undefined;
      stdoutSpy.mockClear();
      await invoke(flag);
      expect(written(stdoutSpy)).toBe(`${packageVersion}\n`);
      expect(process.exitCode).toBe(0);
    }
    expect(runMock).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('opens the help with the version, lists every command with examples, and exits 0', async () => {
    await invoke('--help');
    const help = written(stdoutSpy);
    expect(help.startsWith(`e2e v${packageVersion} · an open framework for agentic end-to-end testing\n`)).toBe(true);
    expect(help).toContain('Usage: e2e <command> [options]');
    expect(help).toMatch(/^ {2}init \[options\] \[directory\] {2,}scaffold/mu);
    expect(help).toMatch(/^ {2}run \[options\] \[files\.\.\.\] {2,}run the tests$/mu);
    expect(help).toMatch(/^ {2}cache {2,}inspect, measure, and clear the replay cache$/mu);
    expect(help).toMatch(/^ {2}mcp \[options\] {2,}serve the project to a coding agent over MCP$/mu);
    expect(help).toMatch(/^ {2}help \[command\] {2,}show help for a command$/mu);
    expect(help).toMatch(/^ {2}-v, --version {2,}print the version$/mu);
    expect(help).toMatch(/^ {2}-h, --help {2,}show help$/mu);
    expect(help).toContain('Examples:\n  $ e2e init\n  $ e2e run\n');
    expect(help).toContain('Run e2e <command> --help for the flags of one command.');
    expect(help).toContain('Docs: https://e2e.tester.army/docs\n');
    expect(process.exitCode).toBe(0);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('groups the run flags, then lists examples and the exit codes', async () => {
    await invoke('run', '--help');
    const help = written(stdoutSpy);
    expect(help).toContain('Usage: e2e run [options] [files...]');
    // Every flag the action reads is documented, under its group, in this order.
    const headings = [...help.matchAll(/^(\S[^\n]*):$/gmu)].map((match) => match[1]);
    expect(headings).toEqual(['Arguments', 'Selection', 'Execution', 'Output', 'Options', 'Examples', 'Exit codes']);
    const flags = [...help.matchAll(/^ {2}(-{1,2}[a-z-]+)/gmu)].map((match) => match[1]);
    expect(flags).toEqual([
      '--config',
      '--target',
      '--tag',
      '--tag-mode',
      '--exclude-tag',
      '--grep',
      '--grep-invert',
      '--last-failed',
      '--shard',
      '--pass-with-no-tests',
      '--headed',
      '--agent',
      '--workers',
      '--retries',
      '--max-failures',
      '--repeat-each',
      '--no-cache',
      '--strict-cache',
      '--reporter',
      '--output',
      '--debug',
      '--ai-trace',
      '--trace',
      '--video',
      '-h',
    ]);
    // Commander wraps at the help width, so the choices may span two lines.
    expect(help).toMatch(/\(choices: "any", "all",\s+default: "any"\)/u);
    expect(help).toContain("  $ e2e run 'tests/**/*.smoke.e2e.ts' --target web --tag smoke\n");
    expect(help).toMatch(/^Exit codes:\n {2}0 {4}every selected test passed/mu);
    expect(help).toMatch(/^ {2}130 {2}interrupted/mu);
    expect(help).toContain('Docs: https://e2e.tester.army/docs/reference/cli#exit-codes\n');
    expect(process.exitCode).toBe(0);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('answers -h and help <command> with the same text as --help', async () => {
    await invoke('run', '--help');
    const expected = written(stdoutSpy);
    for (const args of [['run', '-h'], ['help', 'run']]) {
      process.exitCode = undefined;
      stdoutSpy.mockClear();
      await invoke(...args);
      expect(written(stdoutSpy)).toBe(expected);
      expect(process.exitCode).toBe(0);
    }
    expect(runMock).not.toHaveBeenCalled();
  });

  it('describes init, its directory argument, and its one flag', async () => {
    await invoke('init', '--help');
    const help = written(stdoutSpy);
    expect(help).toContain('Usage: e2e init [options] [directory]');
    expect(help).toContain('without touching existing files');
    expect(help).toMatch(/^ {2}directory {2,}project directory, created when missing/mu);
    expect(help).toMatch(/^ {2}-y, --yes {2,}skip the prompts: Playwright, AI on, no installation$/mu);
    expect(help).toContain('  $ e2e init my-app\n  $ e2e init --yes\n');
    expect(process.exitCode).toBe(0);
  });

  it('prints the help on stderr and exits 2 when no command is given', async () => {
    await invoke();
    expect(stdoutSpy).not.toHaveBeenCalled();
    const help = written(stderrSpy);
    expect(help).toContain('Usage: e2e <command> [options]');
    expect(help).toContain('Examples:');
    expect(process.exitCode).toBe(2);
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe('e2e guide', () => {
  it('prints the overview without frontmatter, exits 0, and never runs', async () => {
    await invoke('guide');
    expect(runMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(written(stdoutSpy).startsWith('# e2e')).toBe(true);
    expect(written(stdoutSpy)).toContain('npx e2e guide <topic>');
  });

  it('prints one topic', async () => {
    await invoke('guide', 'writing-tests');
    expect(process.exitCode).toBe(0);
    expect(written(stdoutSpy).startsWith('# Writing tests')).toBe(true);
  });

  it('rejects an unknown topic with exit code 2 and the topic list', async () => {
    await invoke('guide', 'nope');
    expect(process.exitCode).toBe(2);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(written(stderrSpy)).toBe('unknown topic "nope"; topics: agent, bug-bash, debugging, explore, mcp, running, setup, writing-tests\n');
  });

  it('is listed in the help with an example, and its own help names the topics', async () => {
    await invoke('--help');
    expect(written(stdoutSpy)).toMatch(/^ {2}guide \[topic\] {2,}print the e2e skill for coding agents$/mu);
    expect(written(stdoutSpy)).toContain('  $ e2e guide\n');

    process.exitCode = undefined;
    stdoutSpy.mockClear();
    await invoke('guide', '--help');
    const help = written(stdoutSpy);
    expect(help).toContain('Usage: e2e guide [options] [topic]');
    expect(help).toMatch(/one of agent, bug-bash, debugging, explore, mcp, running, setup,\s+writing-tests/u);
    expect(help).toContain('  $ e2e guide writing-tests\n');
    expect(help).toContain('Docs: https://e2e.tester.army/docs/reference/cli#e2e-guide\n');
    expect(process.exitCode).toBe(0);
    expect(runMock).not.toHaveBeenCalled();
  });
});

describe('e2e feedback', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let configHome: string;

  interface SentEvent {
    event: string;
    uuid: string;
    properties: Record<string, unknown>;
  }

  /** Every feedback event a request carried; the telemetry flush posts its own batch beside them. */
  function sentFeedback(): SentEvent[] {
    return fetchMock.mock.calls
      .flatMap((call: readonly unknown[]) => (JSON.parse((call[1] as { body: string }).body) as { batch: SentEvent[] }).batch)
      .filter((event) => event.event === 'e2e_feedback');
  }

  beforeEach(() => {
    configHome = mkdtempSync(path.join(os.tmpdir(), 'e2e-cli-feedback-'));
    fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('E2E_TELEMETRY_DISABLED', undefined);
    vi.stubEnv('DO_NOT_TRACK', undefined);
    vi.stubEnv('E2E_TELEMETRY_DEBUG', undefined);
    vi.stubEnv('CI', undefined);
    vi.stubEnv('XDG_CONFIG_HOME', configHome);
    vi.stubEnv('APPDATA', configHome);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(configHome, { recursive: true, force: true });
  });

  it.each(['E2E_TELEMETRY_DISABLED', 'DO_NOT_TRACK'])('sends nothing and exits 2 when %s is set', async (variable) => {
    vi.stubEnv(variable, '1');
    await invoke('feedback', '-m', 'broken');
    expect(process.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(written(stderrSpy)).toContain('feedback not sent: this build of e2e never sends anything.');
  });

  it('sends nothing and exits 2: this build never sends a report, whatever the environment says', async () => {
    await invoke('telemetry', 'enable');
    await invoke('feedback', '--type', 'bug', '-m', 'broken');
    expect(process.exitCode).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(written(stderrSpy)).toContain('feedback not sent: this build of e2e never sends anything.');
  });

  it('prints the event and sends nothing with --dry-run, even where sending is off', async () => {
    vi.stubEnv('DO_NOT_TRACK', '1');
    await invoke('feedback', '--type', 'docs', '-m', 'unclear', '--dry-run');
    expect(process.exitCode).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    const printed = JSON.parse(written(stdoutSpy)) as SentEvent;
    expect(printed.event).toBe('e2e_feedback');
    expect(printed.properties).toMatchObject({ type: 'docs', message: 'unclear' });
  });

  it('counts the length limit in characters, not UTF-16 units', async () => {
    await invoke('feedback', '-m', '🐛'.repeat(2000), '--dry-run');
    expect(process.exitCode).toBe(0);
  });

  it('rejects a missing message, a blank one, one over the limit, and an unknown type with exit 2', async () => {
    for (const args of [[], ['-m', '  '], ['-m', 'x'.repeat(2001)], ['--type', 'rant', '-m', 'x']]) {
      process.exitCode = undefined;
      await invoke('feedback', ...args);
      expect(process.exitCode).toBe(2);
    }
    expect(sentFeedback()).toEqual([]);
  });
});

describe('e2e telemetry', () => {
  let configHome: string;

  /** Every `[telemetry] {...}` line the debug mode printed to stderr. */
  function printedEvents(): { event: string; properties: Record<string, unknown> }[] {
    return written(stderrSpy)
      .split('\n')
      .filter((line) => line.startsWith('[telemetry] '))
      .map((line) => JSON.parse(line.slice('[telemetry] '.length)) as { event: string; properties: Record<string, unknown> });
  }

  beforeEach(() => {
    configHome = mkdtempSync(path.join(os.tmpdir(), 'e2e-cli-telemetry-'));
    // The suite-wide opt-out is lifted; debug mode prints instead of sending.
    vi.stubEnv('E2E_TELEMETRY_DISABLED', undefined);
    vi.stubEnv('DO_NOT_TRACK', undefined);
    vi.stubEnv('CI', undefined);
    vi.stubEnv('E2E_TELEMETRY_DEBUG', '1');
    vi.stubEnv('XDG_CONFIG_HOME', configHome);
    vi.stubEnv('APPDATA', configHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(configHome, { recursive: true, force: true });
  });

  it('reports disabled by the build, and enable cannot turn it on', async () => {
    await invoke('telemetry', 'enable');
    await invoke('telemetry');
    expect(written(stdoutSpy)).toContain('Status: disabled (removed from this build; nothing is ever sent)\n');
    expect(written(stdoutSpy)).not.toContain('Status: enabled');
    expect(process.exitCode).toBe(0);
  });

  it('prints no notice and records no event for any command, even in debug mode', async () => {
    await invoke('list');
    await invoke('list', '--tag', 'smoke');
    await invoke('--version');
    expect(written(stderrSpy)).not.toContain('e2e collects anonymous usage telemetry');
    expect(printedEvents()).toEqual([]);
  });

  it('rejects an unknown action with exit code 2', async () => {
    await invoke('telemetry', 'nope');
    expect(process.exitCode).toBe(2);
    expect(written(stderrSpy)).toContain('Allowed choices are status, enable, disable');
  });

  it('records no session for --help, help <command>, or --version', async () => {
    for (const args of [
      ['--help'],
      ['run', '--help'],
      ['login', '--help'],
      ['cache', 'ls', '-h'],
      ['help', 'run'],
      ['--version'],
    ]) {
      process.exitCode = undefined;
      await invoke(...args);
      expect(process.exitCode).toBe(0);
    }
    expect(printedEvents()).toEqual([]);
    expect(runMock).not.toHaveBeenCalled();
  });

  it('is listed in the help with its actions', async () => {
    await invoke('--help');
    expect(written(stdoutSpy)).toMatch(/^ {2}telemetry \[action\] {2,}show, enable, or disable anonymous usage telemetry$/mu);
    expect(written(stdoutSpy)).toContain('  $ e2e telemetry disable\n');

    process.exitCode = undefined;
    stdoutSpy.mockClear();
    await invoke('telemetry', '--help');
    const help = written(stdoutSpy);
    expect(help).toContain('Usage: e2e telemetry [options] [action]');
    expect(help).toContain('E2E_TELEMETRY_DEBUG=1');
    expect(help).toContain('  $ E2E_TELEMETRY_DEBUG=1 e2e run\n');
    expect(help).toContain('Docs: https://e2e.tester.army/docs/telemetry\n');
    expect(process.exitCode).toBe(0);
  });
});
