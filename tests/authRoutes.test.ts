import { expect, test } from "bun:test";
import path from "node:path";

test("support page and APIs enforce authentication through the application router", async () => {
  const child = Bun.spawn([
    process.execPath,
    path.join(import.meta.dir, "integration/authRoutes.runner.ts"),
  ], { cwd: path.resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`Router smoke failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim()).passed).toBeGreaterThanOrEqual(8);
}, 15_000);
