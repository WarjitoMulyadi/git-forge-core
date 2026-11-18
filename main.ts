// main.ts — the trial lifecycle.
//
// The forge is a server, not a script: bind an ephemeral port, tell the env
// where it went, then stay up until the env says the trial is done.

import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl === undefined || envUrl === '') {
  console.error('MAKEFUN_ENV_URL is not set; nowhere to register');
  process.exit(1);
}
const base = envUrl.replace(/\/+$/, '');

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') {
  console.error('the server did not bind a TCP port');
  process.exit(1);
}
const port = address.port;

/** Register the listening port with the env, retrying transient failures. */
async function register(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`the env refused registration with ${response.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('refused registration')) throw error;
    }
    if (Date.now() > deadline) throw new Error('registration never succeeded');
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 2_000);
  }
}

await register();

/** Poll the env until it reports the trial is done. */
async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${base}/done`, { signal: AbortSignal.timeout(30_000) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A transient env failure is not the end of the trial; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

await waitForDone();
await new Promise<void>((resolve) => server.close(() => resolve()));
process.exit(0);
