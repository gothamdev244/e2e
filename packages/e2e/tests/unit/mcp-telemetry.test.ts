/**
 * The `e2e mcp` telemetry wiring against a real server over in-memory
 * streams: with telemetry removed from this build a session produces no
 * event, and the protocol stream carries nothing but protocol.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionTelemetry } from '../../src/cli/mcp.ts';
import { serveMcp } from '../../src/mcp/server.ts';
import { Telemetry } from '../../src/telemetry/telemetry.ts';

const temporaries: string[] = [];

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-telemetry-'));
  temporaries.push(dir);
  return dir;
}

describe('e2e mcp telemetry', () => {
  it('records no session event: telemetry is removed from this build', async () => {
    const cwd = tempDir();
    const debug: string[] = [];
    const telemetry = new Telemetry({
      version: '1.2.3',
      env: { E2E_TELEMETRY_DEBUG: '1' },
      cwd,
      configDir: tempDir(),
      write: (text) => void debug.push(text),
      projectId: async () => undefined,
    });
    telemetry.session('mcp', []);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const frames: string[] = [];
    stdout.on('data', (chunk: Buffer) => frames.push(...chunk.toString().split('\n').filter((line) => line !== '')));
    const served = serveMcp({
      cwd,
      headed: false,
      env: {},
      version: '1.2.3',
      stdin,
      stdout,
      log: () => undefined,
      onSessionEnd: sessionTelemetry(telemetry),
    });
    const send = (message: Record<string, unknown>): void => void stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } } });
    await vi.waitFor(() => expect(frames.some((frame) => (JSON.parse(frame) as { id?: number }).id === 1)).toBe(true));
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/call', params: { name: 'open_session', arguments: { config: 'acme/missing.config.ts' } } });

    const events = () => debug.flatMap((text) => text.split('\n')).filter((line) => line.startsWith('[telemetry] '));
    await vi.waitFor(() => expect(frames.some((frame) => (JSON.parse(frame) as { id?: number }).id === 2)).toBe(true));
    stdin.end();
    await served;
    await telemetry.flush();
    expect(events()).toEqual([]);
    for (const frame of frames) expect(JSON.parse(frame)).toMatchObject({ jsonrpc: '2.0' });
  });
});
