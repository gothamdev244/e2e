// e2e.config.ts
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { copilot } from 'e2e/oauth/copilot';

export default {
  targets: [
    {
      engine: web(),
      app: {
        url: 'http://127.0.0.1:3000',
        command: { executable: 'pnpm', args: ['dev'], log: '.e2e/logs/app.log' },
      },
    },
  ],
  // The model behind every agent.* step: an AI SDK instance. copilot() uses a GitHub Copilot seat
  // (`npx e2e login github-copilot`); `npx e2e models github-copilot` lists the ids your plan serves.
  agents: {
    default: {
      model: copilot('claude-sonnet-5'),
      system: 'You are a thorough QA agent. Verify every outcome on screen.',
    },
  },
} satisfies E2EConfig;
