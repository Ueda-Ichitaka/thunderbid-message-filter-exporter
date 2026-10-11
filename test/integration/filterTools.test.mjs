// About me: End-to-end tests for the extension inside a real, headless
// Thunderbird (see thunderbird.mjs). They open the Message Filters dialog,
// select filters, click the injected Export/Import buttons and check the
// written files and the account's filter list. The native file picker and
// the confirmation prompt are replaced by mocks that return preset answers,
// so no real dialog ever opens.

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { parseFilterFile } from "../../src/filterLogic.mjs";
import { startThunderbird } from "./thunderbird.mjs";

const EMAIL = "testuser@example.org";
const HEADER = 'version="9"\nlogging="no"\n';
const EXPORT_BUTTON = "messageFilterExporter-exportButton";
const IMPORT_BUTTON = "messageFilterExporter-importButton";

function filterBlock(name, { enabled = "yes", action = 'action="Mark read"\n' } = {}) {
  return `name="${name}"\nenabled="${enabled}"\ntype="17"\n${action}condition="AND (subject,contains,${name})"\n`;
}

// Chrome-context setup: a POP3 account with an email identity, Local Folders,
// a mock file picker, a mock prompt service, and helpers the tests call
// through `mfe.*`.
const SETUP = String.raw`
const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");

try {
  MailServices.accounts.localFoldersServer;
} catch {
  // The getter throws when there is no Local Folders account yet.
  MailServices.accounts.createLocalMailAccount();
}
const server = MailServices.accounts.createIncomingServer("testuser", "localhost", "pop3");
const identity = MailServices.accounts.createIdentity();
identity.email = args[0];
const account = MailServices.accounts.createAccount();
account.incomingServer = server;
account.addIdentity(identity);

function registerMock(contractId, iid, create) {
  Components.manager.QueryInterface(Ci.nsIComponentRegistrar).registerFactory(
    Services.uuid.generateUUID(),
    "Mock " + contractId,
    contractId,
    {
      QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
      createInstance(requestedIid) {
        return create().QueryInterface(requestedIid);
      },
    }
  );
}

const modeName = (mode) =>
  Object.keys(Ci.nsIFilePicker).find((key) => key.startsWith("mode") && Ci.nsIFilePicker[key] == mode);

const picker = { path: null, result: Ci.nsIFilePicker.returnOK, calls: [] };
class MockFilePicker {
  QueryInterface = ChromeUtils.generateQI(["nsIFilePicker"]);
  defaultString = "";
  defaultExtension = "";
  displayDirectory = null;
  filterIndex = 0;
  init(browsingContext, title, mode) {
    this.mode = mode;
  }
  appendFilter() {}
  appendFilters() {}
  get file() {
    return picker.path ? new FileUtils.File(picker.path) : null;
  }
  open(callback) {
    picker.calls.push({ mode: modeName(this.mode), defaultString: this.defaultString });
    Services.tm.dispatchToMainThread(() =>
      typeof callback == "function" ? callback(picker.result) : callback.done(picker.result)
    );
  }
}
registerMock("@mozilla.org/filepicker;1", Ci.nsIFilePicker, () => new MockFilePicker());

// confirmEx answers with the button index in prompts.answer.
const prompts = { answer: 1, calls: [] };
class MockPromptService {
  QueryInterface = ChromeUtils.generateQI(["nsIPromptService"]);
  confirmEx(parent, title, text, flags, button0, button1, button2) {
    prompts.calls.push({ text, buttons: [button0, button1, button2] });
    return prompts.answer;
  }
}
registerMock("@mozilla.org/prompter;1", Ci.nsIPromptService, () => new MockPromptService());

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(condition, what) {
  for (let i = 0; i < 100; i++) {
    const value = condition();
    if (value) {
      return value;
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for " + what);
}

globalThis.mfe = {
  picker,
  prompts,
  waitFor,
  sleep,
  server(kind) {
    return kind == "local" ? MailServices.accounts.localFoldersServer : server;
  },
  setFilters(kind, text) {
    const list = this.server(kind).getEditableFilterList(null);
    while (list.filterCount) {
      list.removeFilterAt(0);
    }
    const file = new FileUtils.File(PathUtils.join(PathUtils.tempDir, "mfe-seed.dat"));
    const stream = FileUtils.openFileOutputStream(file);
    const bytes = new TextEncoder().encode(text);
    stream.write(String.fromCharCode(...bytes), bytes.length);
    stream.close();
    const seeded = MailServices.filters.OpenFilterList(file, this.server(kind).rootFolder, null);
    const filters = [];
    for (let i = 0; i < seeded.filterCount; i++) {
      filters.push(seeded.getFilterAt(i));
    }
    for (const filter of filters) {
      list.insertFilterAt(list.filterCount, filter);
    }
    list.saveToDefaultFile();
  },
  filters(kind) {
    const list = this.server(kind).getEditableFilterList(null);
    const result = [];
    for (let i = 0; i < list.filterCount; i++) {
      const filter = list.getFilterAt(i);
      result.push({ name: filter.filterName, enabled: filter.enabled });
    }
    return result;
  },
  defaultFilePath(kind) {
    return this.server(kind).getEditableFilterList(null).defaultFile.path;
  },
  async openDialog(kind) {
    for (const open of Services.wm.getEnumerator("mailnews:filterlist")) {
      open.close();
    }
    await waitFor(() => !Services.wm.getMostRecentWindow("mailnews:filterlist"), "old dialog to close");
    Services.wm.getMostRecentWindow("mail:3pane").MsgFilterList({ folder: this.server(kind).rootFolder });
    const dialog = await waitFor(() => {
      const candidate = Services.wm.getMostRecentWindow("mailnews:filterlist");
      return candidate?.document.readyState == "complete" &&
        candidate.document.getElementById("messageFilterExporter-importButton") &&
        candidate;
    }, "filter dialog with injected buttons");
    dialog.alerts = [];
    dialog.alert = (message) => dialog.alerts.push(message);
    return dialog;
  },
  dialog() {
    return Services.wm.getMostRecentWindow("mailnews:filterlist");
  },
  select(names) {
    const listbox = this.dialog().document.getElementById("filterList");
    listbox.clearSelection();
    for (const item of listbox.itemChildren) {
      if (names.includes(item._filter.filterName)) {
        listbox.addItemToSelection(item);
      }
    }
  },
  // Clicks a button and waits until the action reports a result in the
  // status bar or an alert. With expectResult false (cancelled actions) it
  // waits a fixed time instead.
  async click(buttonId, { expectResult = true } = {}) {
    const dialog = this.dialog();
    const status = dialog.document.getElementById("statusText");
    status.value = "";
    dialog.document.getElementById(buttonId).doCommand();
    if (expectResult) {
      await waitFor(() => status.value || dialog.alerts.length, "button result");
    } else {
      await sleep(1000);
    }
    return { status: status.value, alerts: dialog.alerts };
  },
};
`;

let thunderbird;

async function chrome(body, ...args) {
  return thunderbird.marionette.executeChrome(body, args);
}

async function exportDirectory(name) {
  const directory = path.join(thunderbird.profileDir, name);
  await fs.mkdir(directory);
  return directory;
}

async function accountFilterFile(defaultFilePath) {
  return parseFilterFile(await fs.readFile(defaultFilePath, "utf8"));
}

before(async () => {
  thunderbird = await startThunderbird();
  await chrome(SETUP, EMAIL);
});

after(async () => {
  await thunderbird?.stop();
});

beforeEach(async () => {
  await chrome(`
    mfe.picker.path = null;
    mfe.picker.result = Ci.nsIFilePicker.returnOK;
    mfe.picker.calls.length = 0;
    mfe.prompts.answer = 1;
    mfe.prompts.calls.length = 0;
  `);
});

const THREE_FILTERS = HEADER + filterBlock("First") + filterBlock("Second", { enabled: "no" }) + filterBlock("Third");

test("adds Export and Import buttons below Move to Bottom", async () => {
  const buttons = await chrome(`
    const dialog = await mfe.openDialog("pop");
    const bottom = dialog.document.getElementById("reorderBottomButton");
    const exportButton = bottom.nextElementSibling;
    const importButton = exportButton?.nextElementSibling;
    return [exportButton?.id, exportButton?.label, importButton?.id, importButton?.label];
  `);
  assert.deepEqual(buttons, [EXPORT_BUTTON, "Export...", IMPORT_BUTTON, "Import..."]);
});

test("Export is disabled while no filter is selected", async () => {
  const states = await chrome(
    `
    mfe.setFilters("pop", args[0]);
    const dialog = await mfe.openDialog("pop");
    const button = dialog.document.getElementById(args[1]);
    mfe.select([]);
    const withoutSelection = button.disabled;
    mfe.select(["Second"]);
    const withSelection = button.disabled;
    return { withoutSelection, withSelection };
    `,
    THREE_FILTERS,
    EXPORT_BUTTON
  );
  assert.deepEqual(states, { withoutSelection: true, withSelection: false });
});

test("Export of one selected filter saves only that filter as <email>_<filter>_MessageFilters.dat", async () => {
  const exportPath = path.join(thunderbird.profileDir, "single.dat");
  const result = await chrome(
    `
    mfe.setFilters("pop", args[0]);
    await mfe.openDialog("pop");
    mfe.select(["Second"]);
    mfe.picker.path = args[1];
    const outcome = await mfe.click(args[2]);
    return { ...outcome, calls: mfe.picker.calls, prompts: mfe.prompts.calls, defaultFile: mfe.defaultFilePath("pop") };
    `,
    THREE_FILTERS,
    exportPath,
    EXPORT_BUTTON
  );

  assert.deepEqual(result.calls, [{ mode: "modeSave", defaultString: `${EMAIL}_Second_MessageFilters.dat` }]);
  assert.deepEqual(result.prompts, []);
  assert.deepEqual(result.alerts, []);
  assert.equal(result.status, 'Exported filter "Second" to single.dat.');
  const account = await accountFilterFile(result.defaultFile);
  assert.deepEqual(parseFilterFile(await fs.readFile(exportPath, "utf8")), {
    header: account.header,
    filters: [account.filters[1]],
  });
});

test("Export of several selected filters asks for a folder and writes one file per filter", async () => {
  const directory = await exportDirectory("several");
  const result = await chrome(
    `
    mfe.setFilters("pop", args[0]);
    await mfe.openDialog("pop");
    mfe.select(["First", "Third"]);
    mfe.picker.path = args[1];
    const outcome = await mfe.click(args[2]);
    return { ...outcome, calls: mfe.picker.calls, prompts: mfe.prompts.calls, defaultFile: mfe.defaultFilePath("pop") };
    `,
    THREE_FILTERS,
    directory,
    EXPORT_BUTTON
  );

  assert.deepEqual(result.calls, [{ mode: "modeGetFolder", defaultString: "" }]);
  assert.deepEqual(result.prompts, []);
  assert.deepEqual(result.alerts, []);
  assert.equal(result.status, `Exported 2 filters to ${directory}.`);
  assert.deepEqual((await fs.readdir(directory)).sort(), [
    `${EMAIL}_First_MessageFilters.dat`,
    `${EMAIL}_Third_MessageFilters.dat`,
  ]);
  const account = await accountFilterFile(result.defaultFile);
  for (const [index, name] of [[0, "First"], [2, "Third"]]) {
    const exported = parseFilterFile(await fs.readFile(path.join(directory, `${EMAIL}_${name}_MessageFilters.dat`), "utf8"));
    assert.deepEqual(exported, { header: account.header, filters: [account.filters[index]] });
  }
});

async function exportOverExistingFile(directoryName, promptAnswer) {
  const directory = await exportDirectory(directoryName);
  const existingPath = path.join(directory, `${EMAIL}_First_MessageFilters.dat`);
  await fs.writeFile(existingPath, "old content\n");
  const result = await chrome(
    `
    mfe.setFilters("pop", args[0]);
    await mfe.openDialog("pop");
    mfe.select(["First", "Third"]);
    mfe.picker.path = args[1];
    mfe.prompts.answer = args[3];
    const outcome = await mfe.click(args[2], { expectResult: args[3] != 1 });
    return { ...outcome, prompts: mfe.prompts.calls };
    `,
    THREE_FILTERS,
    directory,
    EXPORT_BUTTON,
    promptAnswer
  );
  return {
    ...result,
    existingContent: await fs.readFile(existingPath, "utf8"),
    files: (await fs.readdir(directory)).sort(),
  };
}

test("Export asks once before overwriting existing files and lists only those", async () => {
  const result = await exportOverExistingFile("overwrite", 0);

  assert.equal(result.prompts.length, 1);
  assert.deepEqual(result.prompts[0].buttons, ["Overwrite", null, "Skip these"]);
  assert.match(result.prompts[0].text, new RegExp(`${EMAIL}_First_MessageFilters\\.dat`));
  assert.doesNotMatch(result.prompts[0].text, /Third/);
  assert.match(result.existingContent, /^version=.*\nname="First"\n/s);
  assert.equal(result.files.length, 2);
  assert.match(result.status, /^Exported 2 filters to /);
});

test("Export with 'Skip these' keeps existing files and writes the others", async () => {
  const result = await exportOverExistingFile("skip", 2);

  assert.equal(result.prompts.length, 1);
  assert.equal(result.existingContent, "old content\n");
  assert.deepEqual(result.files, [`${EMAIL}_First_MessageFilters.dat`, `${EMAIL}_Third_MessageFilters.dat`]);
  assert.match(result.status, /^Exported 1 filter to .*, skipped 1 existing file\.$/);
});

test("Export with 'Skip these' when every file exists writes nothing and says so", async () => {
  const directory = await exportDirectory("skip-all");
  for (const name of ["First", "Third"]) {
    await fs.writeFile(path.join(directory, `${EMAIL}_${name}_MessageFilters.dat`), "old content\n");
  }
  const result = await chrome(
    `
    mfe.setFilters("pop", args[0]);
    await mfe.openDialog("pop");
    mfe.select(["First", "Third"]);
    mfe.picker.path = args[1];
    mfe.prompts.answer = 2;
    return mfe.click(args[2]);
    `,
    THREE_FILTERS,
    directory,
    EXPORT_BUTTON
  );

  assert.equal(result.status, `Exported 0 filters to ${directory}, skipped 2 existing files.`);
  for (const name of ["First", "Third"]) {
    assert.equal(await fs.readFile(path.join(directory, `${EMAIL}_${name}_MessageFilters.dat`), "utf8"), "old content\n");
  }
});

test("Export with Cancel in the overwrite prompt writes nothing", async () => {
  const result = await exportOverExistingFile("cancel", 1);

  assert.equal(result.prompts.length, 1);
  assert.equal(result.existingContent, "old content\n");
  assert.deepEqual(result.files, [`${EMAIL}_First_MessageFilters.dat`]);
  assert.equal(result.status, "");
  assert.deepEqual(result.alerts, []);
});

test("Export of an account without an email address and a non-ASCII filter name", async () => {
  const exportPath = path.join(thunderbird.profileDir, "local.dat");
  const result = await chrome(
    `
    mfe.setFilters("local", args[0]);
    await mfe.openDialog("local");
    mfe.select(["Rechnungen für März"]);
    mfe.picker.path = args[1];
    const outcome = await mfe.click(args[2]);
    return { ...outcome, calls: mfe.picker.calls };
    `,
    HEADER + filterBlock("Rechnungen für März"),
    exportPath,
    EXPORT_BUTTON
  );

  assert.deepEqual(result.calls, [
    { mode: "modeSave", defaultString: "Local Folders_Rechnungen für März_MessageFilters.dat" },
  ]);
  assert.deepEqual(result.alerts, []);
  const exported = parseFilterFile(await fs.readFile(exportPath, "utf8"));
  assert.equal(exported.filters.length, 1);
  assert.match(exported.filters[0], /^name="Rechnungen für März"\n/);
});

test("Import adds only missing filters, ignoring the enabled state", async () => {
  const importPath = path.join(thunderbird.profileDir, "import.dat");
  await fs.writeFile(
    importPath,
    HEADER +
      filterBlock("Existing", { enabled: "no" }) +
      filterBlock("New one", { enabled: "no" }) +
      filterBlock("New one", { enabled: "no" })
  );
  const result = await chrome(
    `
    mfe.setFilters("pop", args[0]);
    const dialog = await mfe.openDialog("pop");
    mfe.picker.path = args[1];
    const outcome = await mfe.click(args[2]);
    return {
      ...outcome,
      calls: mfe.picker.calls,
      filters: mfe.filters("pop"),
      listedInDialog: dialog.document.getElementById("filterList").itemCount,
      defaultFile: mfe.defaultFilePath("pop"),
    };
    `,
    HEADER + filterBlock("Existing"),
    importPath,
    IMPORT_BUTTON
  );

  assert.deepEqual(result.calls, [{ mode: "modeOpen", defaultString: "" }]);
  assert.deepEqual(result.alerts, []);
  assert.match(result.status, /Imported 1 new filter\b.*2 already present/);
  assert.deepEqual(result.filters, [
    { name: "Existing", enabled: true },
    { name: "New one", enabled: false },
  ]);
  assert.equal(result.listedInDialog, 2);
  const saved = await accountFilterFile(result.defaultFile);
  assert.equal(saved.filters.length, 2);
  assert.match(saved.filters[1], /^name="New one"\n/);
});

test("Importing an exported filter into the same account adds nothing", async () => {
  const directory = await exportDirectory("round-trip");
  const result = await chrome(
    `
    mfe.setFilters("pop", args[0]);
    await mfe.openDialog("pop");
    mfe.select(["With header", "Plain"]);
    mfe.picker.path = args[1];
    await mfe.click(args[2]);
    mfe.picker.path = PathUtils.join(args[1], args[4]);
    const outcome = await mfe.click(args[3]);
    return { ...outcome, filters: mfe.filters("pop") };
    `,
    HEADER +
      filterBlock("With header", {
        action: 'action="Move to folder"\nactionValue="mailbox://nobody@Local%20Folders/Trash"\n',
      }).replace("(subject,", '(\\"X-Custom\\",') +
      filterBlock("Plain"),
    directory,
    EXPORT_BUTTON,
    IMPORT_BUTTON,
    `${EMAIL}_With header_MessageFilters.dat`
  );

  assert.deepEqual(result.alerts, []);
  assert.match(result.status, /Imported 0 new filters\b.*1 already present/);
  assert.deepEqual(result.filters.map((filter) => filter.name), ["With header", "Plain"]);
});

test("Cancelling the file picker changes nothing", async () => {
  const result = await chrome(
    `
    mfe.setFilters("pop", args[0]);
    await mfe.openDialog("pop");
    mfe.select(["Only"]);
    mfe.picker.result = Ci.nsIFilePicker.returnCancel;
    const exportOutcome = await mfe.click(args[1], { expectResult: false });
    const importOutcome = await mfe.click(args[2], { expectResult: false });
    return { exportOutcome, importOutcome, filters: mfe.filters("pop"), calls: mfe.picker.calls.length };
    `,
    HEADER + filterBlock("Only"),
    EXPORT_BUTTON,
    IMPORT_BUTTON
  );

  assert.equal(result.calls, 2);
  assert.deepEqual(result.exportOutcome, { status: "", alerts: [] });
  assert.deepEqual(result.importOutcome, { status: "", alerts: [] });
  assert.deepEqual(result.filters, [{ name: "Only", enabled: true }]);
});

test("Importing a file that is not a filter file shows an error and changes nothing", async () => {
  const bogusPath = path.join(thunderbird.profileDir, "not-filters.txt");
  await fs.writeFile(bogusPath, "Hello, I am not a filter file.\n");
  const result = await chrome(
    `
    mfe.setFilters("pop", args[0]);
    await mfe.openDialog("pop");
    mfe.picker.path = args[1];
    const outcome = await mfe.click(args[2]);
    return { ...outcome, filters: mfe.filters("pop") };
    `,
    HEADER + filterBlock("Only"),
    bogusPath,
    IMPORT_BUTTON
  );

  assert.equal(result.alerts.length, 1);
  assert.match(result.alerts[0], /not a Thunderbird message filter file/);
  assert.deepEqual(result.filters, [{ name: "Only", enabled: true }]);
});

test("Disabling the add-on removes the buttons, re-enabling brings them back", async () => {
  const result = await chrome(
    `
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon = await AddonManager.getAddonByID(args[0]);
    const dialog = await mfe.openDialog("pop");
    await addon.disable();
    await mfe.waitFor(() => !dialog.document.getElementById(args[1]), "buttons to disappear");
    await addon.enable();
    const reopened = await mfe.openDialog("pop");
    return [...reopened.document.querySelectorAll("[id^=messageFilterExporter-]")].map((button) => button.id);
    `,
    "message-filter-exporter@richard.rudolph",
    EXPORT_BUTTON
  );

  assert.deepEqual(result, [EXPORT_BUTTON, IMPORT_BUTTON]);
});
