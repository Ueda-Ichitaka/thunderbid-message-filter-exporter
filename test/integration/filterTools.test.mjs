// About me: End-to-end tests for the extension inside a real, headless
// Thunderbird (see thunderbird.mjs). They open the Message Filters dialog,
// select filters, click the injected Export/Import buttons and check the
// written files and the account's filter list. The native file picker and
// the prompt service (questions and the import report) are replaced by mocks
// that return preset answers. Thunderbird's own Filter Editor, which the
// import opens to choose target folders again, is driven through Marionette
// while it is open.

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

// picker.path is the picked file or folder, picker.paths the files picked in
// modeOpenMultiple.
const picker = { path: null, paths: null, result: Ci.nsIFilePicker.returnOK, calls: [] };
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
  get files() {
    const files = (picker.paths ?? [picker.path]).map((path) => new FileUtils.File(path));
    // JS iteration of an XPCOM enumerator calls its [symbol] iterator()
    // method, which a JS component provides as Symbol.iterator.
    const jsEnumerator = {
      QueryInterface: ChromeUtils.generateQI(["nsIJSEnumerator"]),
      [Symbol.iterator]: () => jsEnumerator,
      next: () => (files.length ? { value: files.shift(), done: false } : { value: undefined, done: true }),
    };
    return {
      QueryInterface: ChromeUtils.generateQI(["nsISimpleEnumerator"]),
      hasMoreElements: () => files.length > 0,
      getNext: () => files.shift(),
      [Symbol.iterator]: () => jsEnumerator,
    };
  }
  open(callback) {
    picker.calls.push({ mode: modeName(this.mode), defaultString: this.defaultString });
    Services.tm.dispatchToMainThread(() =>
      typeof callback == "function" ? callback(picker.result) : callback.done(picker.result)
    );
  }
}
registerMock("@mozilla.org/filepicker;1", Ci.nsIFilePicker, () => new MockFilePicker());

// confirmEx answers with the next button index from prompts.answers, or with
// prompts.answer once those are used up. alert records the message.
const prompts = { answer: 1, answers: [], calls: [], alerts: [] };
class MockPromptService {
  QueryInterface = ChromeUtils.generateQI(["nsIPromptService"]);
  confirmEx(parent, title, text, flags, button0, button1, button2) {
    prompts.calls.push({ text, buttons: [button0, button1, button2] });
    return prompts.answers.length ? prompts.answers.shift() : prompts.answer;
  }
  alert(parent, title, text) {
    prompts.alerts.push(text);
  }
}
registerMock("@mozilla.org/prompter;1", Ci.nsIPromptService, () => new MockPromptService());

const localRoot = MailServices.accounts.localFoldersServer.rootFolder;
if (!localRoot.containsChildNamed("Target")) {
  localRoot.createSubfolder("Target", null);
}

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
  // Clicks a button from a separate task and returns at once, so that this
  // Marionette script is not stuck while the action shows a modal dialog.
  startClick(buttonId) {
    const dialog = this.dialog();
    dialog.document.getElementById("statusText").value = "";
    dialog.setTimeout(() => dialog.document.getElementById(buttonId).doCommand(), 0);
  },
  targetFolder() {
    return localRoot.getChildNamed("Target");
  },
  // The Filter Editor that waits for the test, or null. It is ready once its
  // action rows and their folder menus are set up.
  editor() {
    const editor = Services.wm.getMostRecentWindow("mailnews:filtereditor");
    if (!editor || editor.mfeHandled || editor.document.readyState != "complete") {
      return null;
    }
    const doc = editor.document;
    const folderMenusReady = [...doc.querySelectorAll("menulist.folderMenuItem")].every(
      (menulist) => typeof menulist.menupopup?.selectFolder == "function"
    );
    return doc.querySelector(".ruleaction") && folderMenusReady ? editor : null;
  },
  // What an import shows right now: an open Filter Editor, or the result.
  importState() {
    const editor = this.editor();
    if (editor) {
      const doc = editor.document;
      return {
        editor: {
          name: doc.getElementById("filterName").value,
          note: doc.getElementById("messageFilterExporter-importNote")?.textContent ?? null,
          actions: [...doc.querySelectorAll(".ruleaction")].map((row) => ({
            action: row.getAttribute("value"),
            folder: row.querySelector("menulist.folderMenuItem")?.label ?? null,
          })),
        },
      };
    }
    const dialog = this.dialog();
    const status = dialog.document.getElementById("statusText").value;
    if (status || dialog.alerts.length) {
      return { done: true, status, alerts: dialog.alerts, reports: prompts.alerts, questions: prompts.calls };
    }
    return {};
  },
  // Chooses the Target folder for every folder action without a folder and
  // presses OK.
  acceptEditor() {
    const editor = this.editor();
    editor.mfeHandled = true;
    for (const menulist of editor.document.querySelectorAll("menulist.folderMenuItem")) {
      if (!menulist.value) {
        menulist.menupopup.selectFolder(this.targetFolder());
      }
    }
    editor.document.querySelector("dialog").acceptDialog();
  },
  cancelEditor() {
    const editor = this.editor();
    editor.mfeHandled = true;
    editor.document.querySelector("dialog").cancelDialog();
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Clicks Import and waits for its result. Each Filter Editor the import opens
// is passed to onEditor, which has to close it (mfe.acceptEditor() or
// mfe.cancelEditor()). Returns the result state plus the editors seen.
async function runImport(onEditor = (editor) => assert.fail(`Unexpected Filter Editor ${JSON.stringify(editor)}`)) {
  await chrome("mfe.startClick(args[0]);", IMPORT_BUTTON);
  const editors = [];
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = await chrome("return mfe.importState();");
    if (state.editor) {
      editors.push(state.editor);
      await onEditor(state.editor);
    } else if (state.done) {
      return { ...state, editors };
    } else {
      await sleep(100);
    }
  }
  const editorState = await chrome(`
    const editor = Services.wm.getMostRecentWindow("mailnews:filtereditor");
    return editor && {
      readyState: editor.document.readyState,
      rows: editor.document.querySelectorAll(".ruleaction").length,
      folderMenus: [...editor.document.querySelectorAll("menulist.folderMenuItem")].map(
        (menulist) => [menulist.label, typeof menulist.menupopup?.selectFolder]
      ),
    };
  `);
  throw new Error(`The import did not finish, open Filter Editor: ${JSON.stringify(editorState)}`);
}

async function importFiles(localFilters, files, setup = "") {
  const paths = [];
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(thunderbird.profileDir, name);
    await fs.writeFile(filePath, content);
    paths.push(filePath);
  }
  await chrome(
    `
    mfe.setFilters("pop", args[0]);
    await mfe.openDialog("pop");
    mfe.picker.paths = args[1];
    ${setup}
    `,
    localFilters,
    paths
  );
}

async function popFilters() {
  return chrome(`return { filters: mfe.filters("pop"), defaultFile: mfe.defaultFilePath("pop") };`);
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
    mfe.picker.paths = null;
    mfe.prompts.answer = 1;
    mfe.prompts.answers.length = 0;
    mfe.prompts.calls.length = 0;
    mfe.prompts.alerts.length = 0;
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

test("Import of a file with several filters adds new ones and skips those already present", async () => {
  await importFiles(HEADER + filterBlock("Existing"), {
    "import.dat":
      HEADER +
      filterBlock("Existing", { enabled: "no" }) +
      filterBlock("New one", { enabled: "no" }) +
      filterBlock("New one", { enabled: "no" }),
  });
  const result = await runImport();
  const { filters, defaultFile } = await popFilters();
  const calls = await chrome("return mfe.picker.calls;");

  assert.deepEqual(calls, [{ mode: "modeOpenMultiple", defaultString: "" }]);
  assert.deepEqual(result.alerts, []);
  assert.equal(result.status, "Imported import.dat: 1 added, 0 merged, 2 already present, 0 skipped.");
  assert.deepEqual(result.reports, [
    'import.dat\n  The filter "Existing" is already present.\n  Added the filter "New one".\n' +
      '  The filter "New one" is already present.',
  ]);
  assert.deepEqual(filters, [
    { name: "Existing", enabled: true },
    { name: "New one", enabled: false },
  ]);
  const listed = await chrome('return mfe.dialog().document.getElementById("filterList").itemCount;');
  assert.equal(listed, 2);
  const saved = await accountFilterFile(defaultFile);
  assert.equal(saved.filters.length, 2);
  assert.match(saved.filters[1], /^name="New one"\n/);
});

test("Import of several files imports the filter of each file", async () => {
  await importFiles(HEADER, {
    [`${EMAIL}_One_MessageFilters.dat`]: HEADER + filterBlock("One"),
    [`${EMAIL}_Two_MessageFilters.dat`]: HEADER + filterBlock("Two"),
  });
  const result = await runImport();
  const { filters } = await popFilters();

  assert.equal(result.status, "Imported 2 files: 2 added, 0 merged, 0 already present, 0 skipped.");
  assert.equal(result.reports.length, 1);
  assert.match(result.reports[0], /_One_MessageFilters\.dat\n  Added the filter "One"\.\n.*_Two_MessageFilters\.dat\n  Added the filter "Two"\./s);
  assert.doesNotMatch(result.reports[0], /Warning/);
  assert.deepEqual(filters.map((filter) => filter.name), ["One", "Two"]);
});

const FOREIGN_MOVE = 'action="Move to folder"\nactionValue="imap://other%40example.com@imap.example.com/INBOX/Invoices"\n';

test("Import of a Move filter from another account asks for the folder again in the Filter Editor", async () => {
  await importFiles(HEADER, {
    "other@example.com_Invoices_MessageFilters.dat": HEADER + filterBlock("Invoices", { action: FOREIGN_MOVE }),
  });
  const result = await runImport(() => chrome("mfe.acceptEditor();"));
  const { filters, defaultFile } = await popFilters();
  const targetUri = await chrome("return mfe.targetFolder().URI;");

  assert.equal(result.editors.length, 1);
  assert.equal(result.editors[0].name, "Invoices");
  assert.deepEqual(result.editors[0].actions, [{ action: "movemessage", folder: "Choose Folder…" }]);
  assert.match(result.editors[0].note, /Move to folder - previously INBOX\/Invoices \(other@example\.com@imap\.example\.com\)/);
  assert.match(
    result.reports[0],
    /Warning: this file was exported from the account "other@example\.com", not from "testuser@example\.org"\. Its filters were imported anyway\.\n  Added the filter "Invoices"\./
  );
  assert.deepEqual(filters, [{ name: "Invoices", enabled: true }]);
  const saved = await accountFilterFile(defaultFile);
  assert.match(saved.filters[0], new RegExp(`action="Move to folder"\nactionValue="${targetUri}"\n`));
});

test("Cancelling the Filter Editor skips that filter", async () => {
  await importFiles(HEADER, {
    "other@example.com_Invoices_MessageFilters.dat": HEADER + filterBlock("Invoices", { action: FOREIGN_MOVE }),
  });
  const result = await runImport(() => chrome("mfe.cancelEditor();"));
  const { filters } = await popFilters();

  assert.equal(result.status, "Imported other@example.com_Invoices_MessageFilters.dat: 0 added, 0 merged, 0 already present, 1 skipped.");
  assert.match(result.reports[0], /Skipped the filter "Invoices"\./);
  assert.deepEqual(filters, []);
});

test("The Filter Editor note shows a previous folder of this profile by its path and account", async () => {
  await importFiles(HEADER, {
    "Local Folders_Old_MessageFilters.dat":
      HEADER + filterBlock("Old", { action: 'action="Copy to folder"\nactionValue="mailbox://nobody@Local%20Folders/Target"\n' }),
  });
  const result = await runImport(() => chrome("mfe.cancelEditor();"));

  assert.match(result.editors[0].note, /\n  Copy to folder - previously Target \(Local Folders\)$/);
  assert.match(result.reports[0], /Warning: this file was exported from the account "Local Folders_Old"/);
});

test("Import merges a filter into the local filter of the same name in place", async () => {
  const local =
    HEADER +
    filterBlock("Before") +
    'name="Spam"\nenabled="yes"\ntype="17"\naction="Mark read"\ncondition="OR (from,contains,a) OR (from,contains,b)"\n' +
    filterBlock("After");
  await importFiles(local, {
    [`${EMAIL}_Spam_MessageFilters.dat`]:
      HEADER + 'name="Spam"\nenabled="yes"\ntype="17"\naction="Mark flagged"\ncondition="OR (from,contains,b) OR (from,contains,c)"\n',
  });
  const result = await runImport();
  const { filters, defaultFile } = await popFilters();

  assert.equal(result.status, `Imported ${EMAIL}_Spam_MessageFilters.dat: 0 added, 1 merged, 0 already present, 0 skipped.`);
  assert.match(result.reports[0], /Merged into the existing filter "Spam": added 1 condition and 1 action\./);
  assert.deepEqual(result.questions, []);
  assert.deepEqual(filters.map((filter) => filter.name), ["Before", "Spam", "After"]);
  const saved = await accountFilterFile(defaultFile);
  assert.equal(
    saved.filters[1],
    'name="Spam"\nenabled="yes"\ntype="17"\naction="Mark read"\naction="Mark flagged"\n' +
      'condition="OR (from,contains,a) OR (from,contains,b) OR (from,contains,c)"\n'
  );
});

const CONFLICTING_LOCAL =
  HEADER + 'name="Spam"\nenabled="yes"\ntype="17"\naction="Mark read"\ncondition="OR (from,is,a@b.de) OR (subject,contains,x)"\n';
const CONFLICTING_FILE = {
  [`${EMAIL}_Spam_MessageFilters.dat`]:
    HEADER + 'name="Spam"\nenabled="yes"\ntype="16"\naction="Mark read"\ncondition="OR (from,contains,a@b.de)"\n',
};

test("Import asks about each conflict and applies the choices", async () => {
  await importFiles(CONFLICTING_LOCAL, CONFLICTING_FILE, "mfe.prompts.answers.push(0, 2);");
  const result = await runImport();
  const { defaultFile } = await popFilters();

  assert.equal(result.questions.length, 2);
  assert.deepEqual(result.questions[0].buttons, ["Keep local", null, "Use file"]);
  assert.match(result.questions[0].text, /^The imported filter "Spam" from .* differs from your local filter "Spam" in when the filter runs\.\n\nLocal: manually, when getting new mail\nFile: manually\n/);
  assert.match(result.questions[1].text, /in a condition\.\n\nLocal: from is a@b\.de\nFile: from contains a@b\.de\n/);
  assert.match(
    result.reports[0],
    /Merged into the existing filter "Spam": nothing added\.\n    When the filter runs: kept the local manually, when getting new mail instead of manually\.\n    Condition: used the file's from contains a@b\.de instead of from is a@b\.de\./
  );
  const saved = await accountFilterFile(defaultFile);
  assert.equal(
    saved.filters[0],
    'name="Spam"\nenabled="yes"\ntype="17"\naction="Mark read"\ncondition="OR (from,contains,a@b.de) OR (subject,contains,x)"\n'
  );
});

test("Cancel in a conflict question leaves the local filter unchanged", async () => {
  await importFiles(CONFLICTING_LOCAL, CONFLICTING_FILE, "mfe.prompts.answers.push(1);");
  const result = await runImport();
  const { defaultFile } = await popFilters();

  assert.equal(result.questions.length, 1);
  assert.match(result.status, /0 merged, 0 already present, 1 skipped\.$/);
  const saved = await accountFilterFile(defaultFile);
  assert.equal(saved.filters[0], parseFilterFile(CONFLICTING_LOCAL).filters[0]);
});

test("Import merge with a Move action from the file asks for its folder in the Filter Editor", async () => {
  await importFiles(
    HEADER + 'name="Spam"\nenabled="yes"\ntype="17"\naction="Mark read"\ncondition="AND (from,contains,a)"\n',
    {
      "other@example.com_Spam_MessageFilters.dat":
        HEADER + `name="Spam"\nenabled="yes"\ntype="17"\n${FOREIGN_MOVE}condition="AND (from,contains,a)"\n`,
    }
  );
  const result = await runImport(() => chrome("mfe.acceptEditor();"));
  const { defaultFile } = await popFilters();
  const targetUri = await chrome("return mfe.targetFolder().URI;");

  assert.deepEqual(result.editors[0].actions, [
    { action: "markasread", folder: null },
    { action: "movemessage", folder: "Choose Folder…" },
  ]);
  assert.match(result.reports[0], /Merged into the existing filter "Spam": added 0 conditions and 1 action\./);
  const saved = await accountFilterFile(defaultFile);
  assert.match(saved.filters[0], new RegExp(`action="Mark read"\naction="Move to folder"\nactionValue="${targetUri}"\n`));
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
  assert.match(result.status, /: 0 added, 0 merged, 1 already present, 0 skipped\.$/);
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

test("Importing a file that is not a filter file reports it and changes nothing", async () => {
  await importFiles(HEADER + filterBlock("Only"), { "not-filters.txt": "Hello, I am not a filter file.\n" });
  const result = await runImport();
  const { filters } = await popFilters();

  assert.deepEqual(result.alerts, []);
  assert.deepEqual(result.reports, [
    "not-filters.txt\n  Not imported: not-filters.txt is not a Thunderbird message filter file.",
  ]);
  assert.deepEqual(filters, [{ name: "Only", enabled: true }]);
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
