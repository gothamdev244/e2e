/**
 * The Node.js releases e2e runs on, as a set of release ranges. The CLI checks the floor before it loads
 * anything else: package managers only warn about `engines`, so an
 * unsupported runtime would otherwise surface as an unrelated TypeError deep
 * inside a run.
 */

import nodeModule from 'node:module';

type Version = readonly [major: number, minor: number, patch: number];

/**
 * Releases from `since` on: within one release line when `line` is set,
 * else that release and every later line.
 */
type ReleaseRange = { readonly line: number; readonly since: Version } | { readonly since: Version };

function parse(version: string): Version {
  const [major = 0, minor = 0, patch = 0] = version
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return [major, minor, patch];
}

function atLeast(have: Version, need: Version): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (have[i] !== need[i]) return have[i]! > need[i]!;
  }
  return true;
}

function within(version: string, ranges: readonly ReleaseRange[]): boolean {
  const have = parse(version);
  return ranges.some((range) => ('line' in range ? have[0] === range.line : true) && atLeast(have, range.since));
}

/**
 * Where e2e's TypeScript loader works. It runs on `module.registerHooks`, and
 * before these releases a CommonJS file an ES module imported cannot
 * `require()` an ES module the hooks load, such as a project's TypeScript:
 * Node.js throws reading its own cache (nodejs/node#59679, in 22.22.3 and
 * 24.8.0). Node.js 23 has no such release.
 */
const SUPPORTED: readonly ReleaseRange[] = [
  { line: 22, since: [22, 22, 3] },
  { since: [24, 8, 0] },
];

/** `engines.node` in package.json; a unit test keeps the two in step. */
export const SUPPORTED_NODE_RANGE = SUPPORTED.map((range) => `${'line' in range ? '^' : '>='}${range.since.join('.')}`).join(' || ');

/** Explains a Node.js outside `SUPPORTED_NODE_RANGE`, or undefined for one inside it. */
function unsupportedNodeMessage(current: string): string | undefined {
  if (within(current, SUPPORTED)) return undefined;
  const required = SUPPORTED.map((range) => ('line' in range ? `${range.since.join('.')} or newer on Node.js ${range.line}` : `${range.since.join('.')} or newer`)).join(', or ');
  return `e2e requires Node.js ${required}; this is Node.js ${current.replace(/^v/, '')}. Upgrade Node.js, or switch versions with your version manager (nvm install 24, fnm install 24, volta install node@24).`;
}

/**
 * Explains a runtime e2e cannot run on, or undefined for one it can: a
 * Node.js outside `SUPPORTED_NODE_RANGE`, or a runtime that reports a
 * supported Node.js version without Node.js's `module.registerHooks` (Bun),
 * which e2e's TypeScript loader runs on, or Deno.
 */
export function unsupportedRuntimeMessage(
  versions: Pick<NodeJS.ProcessVersions, 'node'> & { readonly bun?: string; readonly deno?: string } = process.versions,
  hasRegisterHooks: boolean = typeof nodeModule.registerHooks === 'function',
): string | undefined {
  // Deno implements module.registerHooks, but not the require() of a native addon from inside a hook that oxc needs.
  if (versions.deno !== undefined) return `e2e runs on Node.js, not Deno ${versions.deno}: run the CLI with Node.js (npx e2e).`;
  // Checked before the Node.js version a runtime reports, which upgrading Node.js does not change.
  if (!hasRegisterHooks) {
    const runtime = versions.bun !== undefined ? `Bun ${versions.bun}` : 'This runtime';
    return `e2e runs on Node.js: ${runtime} reports Node.js ${versions.node} but has no module.registerHooks, which e2e's TypeScript loader needs. Run the CLI with Node.js: npx e2e, or bunx e2e (without --bun).`;
  }
  return unsupportedNodeMessage(versions.node);
}
