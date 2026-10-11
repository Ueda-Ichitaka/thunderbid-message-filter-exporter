// About me: Privileged Experiment API "filterTools" of the message filter
// exporter. It adds "Export..." and "Import..." buttons below "Move to Bottom"
// in Thunderbird's Message Filters dialog and implements them with
// Thunderbird's own filter service:
// - Export writes each filter selected in the dialog to its own file in the
//   native msgFilterRules.dat format, named after account and filter
//   (exportFilenames). One filter: a Save dialog, which itself asks before
//   replacing a file. Several filters: a folder dialog, then one prompt
//   (Overwrite / Skip these / Cancel) if some of the files already exist.
//   Export is disabled while no filter is selected.
// - Import reads one or more picked files (one filter per file as exported,
//   files with several filters work too). A filter without a local filter of
//   the same name is added; otherwise it is merged into the local one
//   (mergeFilterBlocks), asking "Keep local / Use file / Cancel" for every
//   conflict. Move/Copy/Reply actions taken from a file lose their target and
//   Thunderbird's own Filter Editor opens with a note showing the previous
//   target, so the user picks a folder of this account and Thunderbird
//   validates the result; Cancel there skips the filter. Imported and local
//   filters are first written out by Thunderbird itself, so equal filters
//   have equal text. A summary dialog reports each file, including merges and
//   files whose name shows another account.
// Results go to the dialog's status bar, errors to an alert. The pure logic
// lives in src/filterLogic.mjs, loaded through a resource:// alias of the
// extension's root, because ES modules can only be imported from chrome:// or
// resource:// URLs.

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { FileUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/FileUtils.sys.mjs"
);
var { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
var { MailUtils } = ChromeUtils.importESModule(
  "resource:///modules/MailUtils.sys.mjs"
);

const FILTER_LIST_DIALOG_URL = "chrome://messenger/content/FilterListDialog.xhtml";
const FILTER_EDITOR_URL = "chrome://messenger/content/FilterEditor.xhtml";
const WINDOW_LISTENER_ID = "message-filter-exporter@richard.rudolph";
const EDITOR_LISTENER_ID = "message-filter-exporter@richard.rudolph-editor";
const EDITOR_NOTE_ID = "messageFilterExporter-importNote";
// Property of the Filter Editor's arguments that carries the import note.
const EDITOR_NOTE_ARGUMENT = "messageFilterExporterNote";
const EXPORT_BUTTON_ID = "messageFilterExporter-exportButton";
const IMPORT_BUTTON_ID = "messageFilterExporter-importButton";
const FILTER_LIST_ID = "filterList";
const FILTER_FILE_START = /^version="\d+"/;
const OVERWRITE_BUTTON = 0;
const SKIP_BUTTON = 2;
const KEEP_LOCAL_BUTTON = 0;
const USE_FILE_BUTTON = 2;
const IMPORT_TITLE = "Import Message Filters";

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// The email address of the account, or its display name for accounts without
// an identity (e.g. Local Folders, feeds).
function accountName(server) {
  return MailServices.accounts.getFirstIdentityForServer(server)?.email || server.prettyName;
}

// Shows the file picker. Returns the picker, or null when the user cancelled.
function openPicker(window, mode, title, defaultString) {
  const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  picker.init(window.browsingContext, title, mode);
  if (defaultString) {
    picker.defaultString = defaultString;
  }
  if (mode != Ci.nsIFilePicker.modeGetFolder) {
    picker.defaultExtension = "dat";
    picker.appendFilter("Message filter files", "*.dat");
    picker.appendFilters(Ci.nsIFilePicker.filterAll);
  }
  return new Promise((resolve) => {
    picker.open((result) => {
      resolve(result == Ci.nsIFilePicker.returnCancel ? null : picker);
    });
  });
}

async function pickFile(window, mode, title, defaultString) {
  return (await openPicker(window, mode, title, defaultString))?.file ?? null;
}

async function pickFiles(window, title) {
  const picker = await openPicker(window, Ci.nsIFilePicker.modeOpenMultiple, title);
  return picker ? [...picker.files] : [];
}

function promptService() {
  return Cc["@mozilla.org/prompter;1"].getService(Ci.nsIPromptService);
}

async function withTemporaryFile(callback) {
  const path = await IOUtils.createUniqueFile(PathUtils.tempDir, "message-filter-exporter.dat");
  try {
    return await callback(new FileUtils.File(path));
  } finally {
    await IOUtils.remove(path, { ignoreAbsent: true });
  }
}

// The text Thunderbird itself writes for a filter list.
function filterListText(filterList) {
  return withTemporaryFile(async (file) => {
    MailServices.filters.SaveFilterList(filterList, file);
    return IOUtils.readUTF8(file.path);
  });
}

// The text block Thunderbird itself writes for a single filter.
function filterText(filter) {
  const storage = Cc["@mozilla.org/storagestream;1"].createInstance(Ci.nsIStorageStream);
  storage.init(4096, 0xffffffff);
  const output = storage.getOutputStream(0);
  filter.SaveToTextFile(output);
  output.close();
  const input = storage.newInputStream(0);
  return NetUtil.readInputStreamToString(input, input.available(), { charset: "UTF-8" });
}

// Thunderbird filter objects parsed from filter file text.
function filtersFromText(text, folder) {
  return withTemporaryFile(async (file) => {
    await IOUtils.writeUTF8(file.path, text);
    const parsedList = MailServices.filters.OpenFilterList(file, folder, null);
    const filters = [];
    for (let i = 0; i < parsedList.filterCount; i++) {
      filters.push(parsedList.getFilterAt(i));
    }
    return filters;
  });
}

function setStatus(window, message) {
  window.document.getElementById("statusText").value = message;
}

function filterListbox(window) {
  return window.document.getElementById(FILTER_LIST_ID);
}

function selectedFilters(window) {
  return Array.from(filterListbox(window).selectedItems, (item) => item._filter);
}

// Asks before overwriting existing files. Returns OVERWRITE_BUTTON,
// SKIP_BUTTON, or anything else for Cancel (also when the prompt is closed).
function askOverwrite(window, folder, existingFiles) {
  const prompts = promptService();
  return prompts.confirmEx(
    window,
    "Export Message Filters",
    `Some files already exist in ${folder.path}:\n\n` +
      existingFiles.map((file) => `  ${file.leafName}`).join("\n"),
    prompts.BUTTON_TITLE_IS_STRING * prompts.BUTTON_POS_0 +
      prompts.BUTTON_TITLE_CANCEL * prompts.BUTTON_POS_1 +
      prompts.BUTTON_TITLE_IS_STRING * prompts.BUTTON_POS_2 +
      prompts.BUTTON_POS_1_DEFAULT,
    "Overwrite",
    null,
    "Skip these",
    null,
    {}
  );
}

// Asks where to save. Returns { folder, targets: [{ file, filter }], skipped }
// with the files to write and the number of existing files the user chose to
// skip, or null when the user cancelled.
async function exportTargets(window, filters, filenames) {
  if (filters.length == 1) {
    const file = await pickFile(window, Ci.nsIFilePicker.modeSave, "Export Message Filter", filenames[0]);
    return file && { folder: file.parent, targets: [{ file, filter: filters[0] }], skipped: 0 };
  }

  const folder = await pickFile(window, Ci.nsIFilePicker.modeGetFolder, "Export Message Filters to Folder");
  if (!folder) {
    return null;
  }
  const targets = filters.map((filter, index) => {
    const file = folder.clone();
    file.append(filenames[index]);
    return { file, filter };
  });
  const existing = targets.filter(({ file }) => file.exists());
  if (existing.length == 0) {
    return { folder, targets, skipped: 0 };
  }
  switch (askOverwrite(window, folder, existing.map(({ file }) => file))) {
    case OVERWRITE_BUTTON:
      return { folder, targets, skipped: 0 };
    case SKIP_BUTTON:
      return {
        folder,
        targets: targets.filter((target) => !existing.includes(target)),
        skipped: existing.length,
      };
    default:
      return null;
  }
}

async function exportFilters(window, logic) {
  const filters = selectedFilters(window);
  if (filters.length == 0) {
    return;
  }
  const filterList = window.gCurrentFilterList;
  const filenames = logic.exportFilenames(
    accountName(filterList.folder.server),
    filters.map((filter) => filter.filterName)
  );
  const choice = await exportTargets(window, filters, filenames);
  if (!choice) {
    return;
  }

  const header = logic.parseFilterFile(await filterListText(filterList)).header;
  for (const { file, filter } of choice.targets) {
    await IOUtils.writeUTF8(file.path, logic.buildFilterFile(header, [filterText(filter)]));
  }

  if (filters.length == 1) {
    setStatus(window, `Exported filter "${filters[0].filterName}" to ${choice.targets[0].file.leafName}.`);
  } else {
    const skipped = choice.skipped ? `, skipped ${plural(choice.skipped, "existing file")}` : "";
    setStatus(
      window,
      `Exported ${plural(choice.targets.length, "filter")} to ${choice.folder.path}${skipped}.`
    );
  }
}

// Asks which side of a merge conflict to keep: "local", "file", or null for
// Cancel (also when the prompt is closed).
function askConflict(window, logic, filterName, fileName, conflict) {
  const prompts = promptService();
  const button = prompts.confirmEx(
    window,
    IMPORT_TITLE,
    logic.conflictQuestion(filterName, fileName, conflict),
    prompts.BUTTON_TITLE_IS_STRING * prompts.BUTTON_POS_0 +
      prompts.BUTTON_TITLE_CANCEL * prompts.BUTTON_POS_1 +
      prompts.BUTTON_TITLE_IS_STRING * prompts.BUTTON_POS_2 +
      prompts.BUTTON_POS_0_DEFAULT,
    "Keep local",
    null,
    "Use file",
    null,
    {}
  );
  if (button == KEEP_LOCAL_BUTTON) {
    return "local";
  }
  return button == USE_FILE_BUTTON ? "file" : null;
}

// A folder of this profile as "path (account)", otherwise described from its
// URI alone.
function describeFolder(logic, uri) {
  const folder = MailUtils.getExistingFolder(uri);
  return folder ? `${folder.prettyPath} (${folder.server.prettyName})` : logic.describeFolderUri(uri);
}

function describeTemplate(uri) {
  try {
    const header = MailServices.messageServiceFromURI(uri).messageURIToMsgHdr(uri);
    return `the template "${header.mime2DecodedSubject}"`;
  } catch {
    return uri;
  }
}

function describeTarget(logic, { action, previous }) {
  if (!previous) {
    return "";
  }
  return action == "Reply" ? describeTemplate(previous) : describeFolder(logic, previous);
}

// Turns a filter block into a Thunderbird filter. When reselect lists
// actions whose target was cleared, Thunderbird's Filter Editor opens so the
// user chooses them again. Returns the filter, or null when the user
// cancelled the editor.
async function filterWithTargets(window, logic, filterList, header, block, reselect, fileName) {
  const [filter] = await filtersFromText(logic.buildFilterFile(header, [block]), filterList.folder);
  if (reselect.length == 0) {
    return filter;
  }
  const targets = reselect.map((target) => ({ action: target.action, previous: describeTarget(logic, target) }));
  const args = { filter, filterList, [EDITOR_NOTE_ARGUMENT]: logic.editorNote(fileName, targets) };
  window.openDialog(FILTER_EDITOR_URL, "FilterEditor", "chrome,modal,titlebar,resizable,centerscreen", args);
  return args.refresh ? filter : null;
}

// Adds or merges one imported filter block. Returns its report entry.
async function importFilter(window, logic, filterList, block, fileName) {
  const name = logic.filterDisplayName(block);
  const skipped = { name, outcome: "skipped" };
  const { header, filters: localBlocks } = logic.parseFilterFile(await filterListText(filterList));
  // Thunderbird writes the filters in list order, so block and list indexes match.
  const index = localBlocks.findIndex((localBlock) => logic.filterDisplayName(localBlock) == name);

  if (index < 0) {
    const prepared = logic.prepareNewFilter(block);
    const filter = await filterWithTargets(window, logic, filterList, header, prepared.block, prepared.reselect, fileName);
    if (!filter) {
      return skipped;
    }
    filterList.insertFilterAt(filterList.filterCount, filter);
    return { name, outcome: "added" };
  }

  const merge = logic.mergeFilterBlocks(
    localBlocks[index],
    block,
    (conflict) => askConflict(window, logic, name, fileName, conflict),
    { describeFolder: (uri) => describeFolder(logic, uri) }
  );
  if (merge.cancelled) {
    return skipped;
  }
  const merged = {
    name,
    outcome: "merged",
    addedConditions: merge.addedConditions,
    addedActions: merge.addedActions,
    decisions: merge.decisions,
  };
  if (!merge.changed) {
    return merge.decisions.length ? merged : { name, outcome: "present" };
  }
  const filter = await filterWithTargets(window, logic, filterList, header, merge.block, merge.reselect, fileName);
  if (!filter) {
    return skipped;
  }
  filterList.removeFilterAt(index);
  filterList.insertFilterAt(index, filter);
  return merged;
}

// Imports all filters of one file. Returns its report entry.
async function importFile(window, logic, filterList, file, account) {
  const result = {
    file: file.leafName,
    otherAccount: logic.otherAccountInFilename(file.leafName, account),
    filters: [],
  };
  try {
    if (!FILTER_FILE_START.test(await IOUtils.readUTF8(file.path))) {
      throw new Error(`${file.leafName} is not a Thunderbird message filter file.`);
    }
    const importText = await filterListText(MailServices.filters.OpenFilterList(file, filterList.folder, null));
    for (const block of logic.parseFilterFile(importText).filters) {
      result.filters.push(await importFilter(window, logic, filterList, block, file.leafName));
    }
  } catch (error) {
    console.error(`[message-filter-exporter] Import of ${file.leafName} failed`, error);
    result.error = error.message;
  }
  return result;
}

async function importFilters(window, logic) {
  const files = await pickFiles(window, IMPORT_TITLE);
  if (files.length == 0) {
    return;
  }
  const filterList = window.gCurrentFilterList;
  const account = accountName(filterList.folder.server);
  const results = [];
  try {
    for (const file of files) {
      results.push(await importFile(window, logic, filterList, file, account));
    }
  } finally {
    filterList.saveToDefaultFile();
    window.rebuildFilterList();
  }
  setStatus(window, logic.importStatus(results));
  promptService().alert(window, IMPORT_TITLE, logic.importReport(account, results));
}

// Shows the import note above the actions of a Filter Editor opened by
// filterWithTargets.
function addEditorNote(window) {
  const note = window.arguments?.[0]?.[EDITOR_NOTE_ARGUMENT];
  const actionsBox = window.document.getElementById("filterActionsBox");
  if (!note || !actionsBox || window.document.getElementById(EDITOR_NOTE_ID)) {
    return;
  }
  const description = window.document.createXULElement("description");
  description.id = EDITOR_NOTE_ID;
  description.style.whiteSpace = "pre-wrap";
  description.textContent = note;
  actionsBox.before(description);
}

function addButton(window, id, label, action) {
  const button = window.document.createXULElement("button");
  button.id = id;
  button.setAttribute("label", label);
  button.addEventListener("command", () => {
    action().catch((error) => {
      console.error(`[message-filter-exporter] ${label} failed`, error);
      window.alert(`Message filter ${label.replace("...", "").toLowerCase()} failed:\n${error.message}`);
    });
  });
  return button;
}

function injectButtons(window, logic) {
  const bottomButton = window.document.getElementById("reorderBottomButton");
  if (!bottomButton || window.document.getElementById(EXPORT_BUTTON_ID)) {
    return;
  }
  const exportButton = addButton(window, EXPORT_BUTTON_ID, "Export...", () => exportFilters(window, logic));
  bottomButton.after(
    exportButton,
    addButton(window, IMPORT_BUTTON_ID, "Import...", () => importFilters(window, logic))
  );

  // The listbox element is looked up directly: this runs on the window's load
  // event, possibly before the dialog's own onLoad has set its globals.
  const listbox = filterListbox(window);
  const updateExportButton = () => {
    exportButton.disabled = listbox.selectedCount == 0;
  };
  listbox.addEventListener("select", updateExportButton);
  updateExportButton();
}

function removeButtons(window) {
  for (const id of [EXPORT_BUTTON_ID, IMPORT_BUTTON_ID]) {
    window.document.getElementById(id)?.remove();
  }
}

var filterTools = class extends ExtensionCommon.ExtensionAPI {
  resourceHost = null;

  getAPI(context) {
    return {
      filterTools: {
        initialize: async () => this.initialize(),
      },
    };
  }

  // Safe to call more than once: the background page is an event page and
  // may run again later in the same session.
  initialize() {
    if (this.resourceHost) {
      return;
    }
    // A fresh alias per startup, so an updated extension never gets the old
    // module from the ES module cache.
    this.resourceHost = `message-filter-exporter-${Services.uuid.generateUUID().toString().slice(1, -1)}`;
    resourceHandler().setSubstitution(this.resourceHost, this.extension.rootURI);
    const logic = ChromeUtils.importESModule(`resource://${this.resourceHost}/src/filterLogic.mjs`);

    ExtensionSupport.registerWindowListener(WINDOW_LISTENER_ID, {
      chromeURLs: [FILTER_LIST_DIALOG_URL],
      onLoadWindow: (window) => injectButtons(window, logic),
    });
    ExtensionSupport.registerWindowListener(EDITOR_LISTENER_ID, {
      chromeURLs: [FILTER_EDITOR_URL],
      onLoadWindow: addEditorNote,
    });
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown || !this.resourceHost) {
      return;
    }
    ExtensionSupport.unregisterWindowListener(WINDOW_LISTENER_ID);
    ExtensionSupport.unregisterWindowListener(EDITOR_LISTENER_ID);
    for (const window of Services.wm.getEnumerator("mailnews:filterlist")) {
      removeButtons(window);
    }
    resourceHandler().setSubstitution(this.resourceHost, null);
    this.resourceHost = null;
  }
};

function resourceHandler() {
  return Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler);
}
