// Entry point: the harness lifecycle for this forge.
//
// The trial environment (the "env") is a small server whose origin comes in
// through MAKEFUN_ENV_URL. This process has exactly one job sequence:
//
//   1. Build the app and bind it to a kernel-chosen port — never 8080,
//      which belongs to the env on the same loopback.
//   2. Tell the env that port with POST /register {"port": N}. The first
//      registration wins; a 409 only means somebody else already won, so
//      this process carries on waiting like any other.
//   3. Poll GET /done until the env answers {"done": true}, then shut the
//      server down and exit 0. Never exit early: the env writes the scored
//      export only after it says done.
//
// Both the register and the poll are retried with exponential backoff
// (250 ms doubling to a 2000 ms ceiling, 30 s per attempt), because the
// env may still be starting when this process comes up. A 400 or 405 from
// register is a contract error and ends the process; anything else is
// retried. Without MAKEFUN_ENV_URL there is no env to talk to, so the
// process exits 1 immediately.
//
// Only the app module is imported here, plus Node built-ins (none needed —
// fetch and the process globals are enough).

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[forge] MAKEFUN_ENV_URL is unset — no env to register with\n');
  process.exit(1);
}

const ATTEMPT_TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_CEILING_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(failures: number): number {
  const doubled = BACKOFF_START_MS * 2 ** Math.min(failures, 8);
  return Math.min(BACKOFF_CEILING_MS, doubled);
}

/** Register the bound port; 200 and 409 both mean "carry on waiting". */
async function announce(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const answer = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (answer.status === 200 || answer.status === 409) return;
      if (answer.status === 400 || answer.status === 405) {
        throw new Error(`register refused with HTTP ${answer.status}: ${await answer.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) throw err;
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

/** Keep asking GET /done until the env says the trial is over. */
async function waitUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const answer = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Env unreachable or slow: it is not done yet, so poll again.
    }
    await pause(backoffMs(failures));
    failures += 1;
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('server did not bind a TCP port');
  }
  process.stdout.write(`[forge] listening on ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('[forge] registered; polling the env for done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[forge] env is done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[forge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
