import { describe, expect, test } from "bun:test";

/**
 * Opt in with PostgreSQL and Redis test URLs. The PostgreSQL user must be able
 * to create databases.
 * The runner creates and drops its own randomly named database, leaving the
 * supplied database untouched. A subprocess keeps unit-test module mocks out.
 */
describe.skipIf(!Bun.env.CRISPAI_TEST_DATABASE_URL || !Bun.env.CRISPAI_TEST_REDIS_URL)("PostgreSQL integration", () => {
  test("legacy migration, support controls and API persistence", async () => {
    const process = Bun.spawn(
      [Bun.which("bun") ?? globalThis.process.execPath, "tests/integration/database.runner.ts"],
      {
        cwd: import.meta.dir + "/..",
        env: { ...Bun.env, NODE_ENV: "test" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (code !== 0) throw new Error(`Database integration failed:\n${stdout}\n${stderr}`);
    expect(stdout).toContain("Database integration checks passed:");
  }, 60_000);
});
