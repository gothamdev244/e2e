#!/usr/bin/env node
import { unsupportedRuntimeMessage } from '../internal/node-version.ts';

// Checked before the CLI module loads: that module and its dependencies are
// what an old runtime would fail on, with a stack trace instead of a sentence.
const unsupported = unsupportedRuntimeMessage();
if (unsupported !== undefined) {
  process.stderr.write(`${unsupported}\n`);
  process.exit(2);
}

const { main } = await import('./index.ts');
await main(process.argv);
