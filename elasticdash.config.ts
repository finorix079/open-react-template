/**
 * elasticdash.config.ts
 *
 * ElasticDash Test configuration.
 *
 * HTTP workflow mode is used for Next.js — the dashboard and test runner call
 * the live dev server directly instead of importing the route handler as a
 * subprocess.  Start the project first (`npm run dev`), then the dashboard
 * (`npx elasticdash dashboard`).
 */

const APP_URL = process.env.APP_URL ?? 'http://localhost:3001';

export default {
  testMatch: ['**/*.ai.test.ts'],
  workflows: {
    chatHandler: {
      mode: 'http' as const,
      url: `${APP_URL}/api/chat`,
      method: 'POST' as const,
      headers: {
        'Content-Type': 'application/json',
      },
      bodyTemplate: {
        messages: '{{input.messages}}',
        sessionId: '{{input.sessionId}}',
        isApproval: '{{input.isApproval}}',
      },
      responseFormat: 'json' as const,
    },
    chatStreamHandler: {
      mode: 'http' as const,
      url: `${APP_URL}/api/chat-stream`,
      method: 'POST' as const,
      headers: {
        'Content-Type': 'application/json',
      },
      bodyTemplate: {
        messages: '{{input.messages}}',
        sessionId: '{{input.sessionId}}',
      },
      responseFormat: 'vercel-ai-stream' as const,
    },
  },
};
