import { expect, test } from "bun:test";
import path from "node:path";

test("support flows run through the real processors with isolated external dependencies", async () => {
  // Bun module mocks are process-global. Run them in a child so the Redis and
  // PostgreSQL integration suites continue to use their real dependencies.
  const child = Bun.spawn([
    process.execPath,
    path.join(import.meta.dir, "integration/supportFlow.runner.ts"),
  ], { cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`Support flow subprocess failed:\n${stdout}\n${stderr}`);
  const result = JSON.parse(stdout.trim());
  expect(result.passed).toBeGreaterThanOrEqual(10);
}, 15_000);
