import { execFile } from "node:child_process";
import { mkdir, readdir, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
/** Test-owned repository only; the source checkout is never part of this fixture. */
export async function prepareOpenAiHostedFixture(workspace: string) {
  if ((await readdir(workspace)).length !== 0) throw new Error("OpenAI fixture requires an empty disposable workspace");
  const source = path.join(path.dirname(workspace), "openai-fixture-source");
  await mkdir(source, { recursive: false });
  await exec("git", ["init", "-q", source]);
  await writeFile(path.join(source, "seed.txt"), "OpenAI hosted fixture baseline\n");
  await exec("git", ["-C", source, "add", "seed.txt"]);
  await exec("git", ["-C", source, "-c", "user.name=Runner E2E", "-c", "user.email=runner@example.invalid", "commit", "-qm", "Fixture baseline"]);
  await rmdir(workspace);
  await exec("git", ["-C", source, "worktree", "add", "--detach", workspace, "HEAD"]);
}
