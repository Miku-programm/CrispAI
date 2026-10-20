import { expect, test } from "bun:test";
import path from "node:path";

test.skipIf(!process.env.SESSION_QUEUE_TEST_REDIS_URL)(
  "Crisp arrival rate blocks floods before processing and deduplicates retries in real Redis",
  async () => {
    const child = Bun.spawn([
      process.execPath,
      path.join(import.meta.dir, "integration/abuseIngress.runner.ts"),
    ], {
      cwd: path.resolve(import.meta.dir, ".."),
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, REDIS_URL: process.env.SESSION_QUEUE_TEST_REDIS_URL },
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`Abuse ingress subprocess failed:\n${stdout}\n${stderr}`);
    expect(JSON.parse(stdout).passed).toBe(5);
  },
  15_000,
);
