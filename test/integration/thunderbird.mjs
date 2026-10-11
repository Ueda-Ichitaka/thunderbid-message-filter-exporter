// About me: Starts and stops a headless Thunderbird for the integration tests.
// Each run gets a fresh, throw-away profile with the built extension
// (dist/message-filter-exporter-<version>.xpi) pre-installed and Marionette enabled, so
// the user's real Thunderbird profile is never touched.
//
// By default Thunderbird runs as the Flatpak org.mozilla.thunderbird_esr. A
// Flatpak can only see a few host directories, so the profile is created
// inside the app's own data directory (~/.var/app/<id>/). Environment
// variables:
//   THUNDERBIRD_FLATPAK_ID  Flatpak app id to run (default org.mozilla.thunderbird_esr)
//   THUNDERBIRD_BIN         path to a non-Flatpak thunderbird binary instead;
//                           the profile then goes to the system temp directory
//   KEEP_TEST_PROFILE=1     keep the profile directory after the run

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Marionette } from "./marionette.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FLATPAK_ID = process.env.THUNDERBIRD_FLATPAK_ID ?? "org.mozilla.thunderbird_esr";
const THUNDERBIRD_BIN = process.env.THUNDERBIRD_BIN;

const PROFILE_PREFS = {
  "devtools.console.stdout.chrome": true,
  "devtools.console.stdout.content": true,
  "extensions.autoDisableScopes": 0,
  "mail.provider.suppress_dialog_on_startup": true,
  "mail.shell.checkDefaultClient": false,
  "mail.spotlight.firstRunDone": true,
  "datareporting.policy.dataSubmissionEnabled": false,
  "app.update.disabledForTesting": true,
};

async function readManifest() {
  return JSON.parse(await fs.readFile(path.join(PROJECT_DIR, "manifest.json"), "utf8"));
}

async function xpiPath() {
  const { version } = await readManifest();
  return path.join(PROJECT_DIR, "dist", `message-filter-exporter-${version}.xpi`);
}

async function addonId() {
  return (await readManifest()).browser_specific_settings.gecko.id;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function userJs(prefs) {
  return Object.entries(prefs)
    .map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});\n`)
    .join("");
}

async function createProfile(port) {
  const parent = THUNDERBIRD_BIN ? os.tmpdir() : path.join(os.homedir(), ".var/app", FLATPAK_ID);
  const profileDir = await fs.mkdtemp(path.join(parent, "mfe-integration-"));
  await fs.mkdir(path.join(profileDir, "extensions"));
  await fs.copyFile(await xpiPath(), path.join(profileDir, "extensions", `${await addonId()}.xpi`));
  await fs.writeFile(
    path.join(profileDir, "user.js"),
    userJs({ ...PROFILE_PREFS, "marionette.port": port })
  );
  return profileDir;
}

function launchCommand(profileDir) {
  const thunderbirdArgs = [
    "--headless",
    "--new-instance",
    "--marionette",
    "-remote-allow-system-access",
    "--profile",
    profileDir,
  ];
  return THUNDERBIRD_BIN
    ? [THUNDERBIRD_BIN, thunderbirdArgs]
    : ["flatpak", ["run", FLATPAK_ID, ...thunderbirdArgs]];
}

// Thunderbird processes that belong to this test profile. Only these are
// ever killed, never another (e.g. the user's own) Thunderbird instance.
async function processesUsingProfile(profileDir) {
  const pids = [];
  for (const entry of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) {
      continue;
    }
    try {
      const args = (await fs.readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0");
      const program = path.basename(args[0]);
      if (["thunderbird", "thunderbird-bin", "bwrap", "flatpak"].includes(program) && args.includes(profileDir)) {
        pids.push(Number(entry));
      }
    } catch {
      // The process exited while we were looking at it.
    }
  }
  return pids;
}

async function waitForExit(profileDir, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await processesUsingProfile(profileDir)).length === 0) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

export async function startThunderbird() {
  const xpi = await xpiPath();
  await fs.access(xpi).catch(() => {
    throw new Error(`${xpi} is missing, run "npm run build" first`);
  });
  const port = await freePort();
  const profileDir = await createProfile(port);
  const output = [];
  const [command, commandArgs] = launchCommand(profileDir);
  const child = spawn(command, commandArgs, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (data) => output.push(data.toString()));
  child.stderr.on("data", (data) => output.push(data.toString()));

  const marionette = await Marionette.connect(port);
  await marionette.startChromeSession();

  return {
    profileDir,
    marionette,
    output: () => output.join(""),
    async stop() {
      await marionette.quit();
      if (!(await waitForExit(profileDir, 20_000))) {
        for (const pid of await processesUsingProfile(profileDir)) {
          process.kill(pid, "SIGKILL");
        }
        await waitForExit(profileDir, 5_000);
      }
      if (!process.env.KEEP_TEST_PROFILE) {
        await fs.rm(profileDir, { recursive: true, force: true });
      }
    },
  };
}
