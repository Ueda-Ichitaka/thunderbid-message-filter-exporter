// About me: Unit tests for scripts/publish-release.sh, the release step of the
// GitHub workflow. A fake `gh` command on PATH records its arguments and
// pretends a release does or does not exist, so no GitHub access is needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/publish-release.sh"
);

// Runs the script with a fake gh. existingReleases lists the tags for which
// `gh release view` succeeds.
async function runPublish(args, { existingReleases = [] } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "publish-release-test-"));
  const log = path.join(directory, "gh.log");
  await fs.writeFile(
    path.join(directory, "gh"),
    `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1 $2" = "release view" ]; then
  for tag in ${existingReleases.join(" ")}; do
    [ "$3" = "$tag" ] && exit 0
  done
  exit 1
fi
exit 0
`,
    { mode: 0o755 }
  );
  const xpi = path.join(directory, "addon.xpi");
  await fs.writeFile(xpi, "fake xpi");
  try {
    const { stdout } = await promisify(execFile)(SCRIPT, args(xpi), {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, GITHUB_SHA: "abc123" },
    });
    return { exitCode: 0, stdout, calls: await readCalls(log), xpi };
  } catch (error) {
    return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr, calls: await readCalls(log), xpi };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function readCalls(log) {
  const text = await fs.readFile(log, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean);
}

test("creates release v<version> with the package when it does not exist yet", async () => {
  const result = await runPublish((xpi) => ["0.3.0", xpi]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.calls, [
    "release view v0.3.0",
    `release create v0.3.0 ${result.xpi} --target abc123 --title Message Filter Exporter 0.3.0 --generate-notes`,
  ]);
});

test("leaves an existing release untouched", async () => {
  const result = await runPublish((xpi) => ["0.3.0", xpi], { existingReleases: ["v0.3.0"] });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.calls, ["release view v0.3.0"]);
  assert.match(result.stdout, /Release v0\.3\.0 already exists/);
});

test("creates a new release next to existing older ones", async () => {
  const result = await runPublish((xpi) => ["0.4.0", xpi], { existingReleases: ["v0.3.0"] });
  assert.equal(result.exitCode, 0);
  assert.equal(result.calls.length, 2);
  assert.match(result.calls[1], /^release create v0\.4\.0 /);
});

test("fails without touching GitHub when the package file is missing", async () => {
  const result = await runPublish(() => ["0.3.0", "/nonexistent/addon.xpi"]);
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(result.calls, []);
});

test("fails without touching GitHub when arguments are missing", async () => {
  const result = await runPublish(() => ["0.3.0"]);
  assert.notEqual(result.exitCode, 0);
  assert.deepEqual(result.calls, []);
});
