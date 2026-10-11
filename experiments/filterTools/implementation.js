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
// - Import reads such a file and appends only the filters the account does
//   not have yet (selectNewFilters). Both sides are first written out by
//   Thunderbird itself, so equal filters have equal text.
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

const FILTER_LIST_DIALOG_URL = "chrome://messenger/content/FilterListDialog.xhtml";
const WINDOW_LISTENER_ID = "message-filter-exporter@richard.rudolph";
const EXPORT_BUTTON_ID = "messageFilterExporter-exportButton";
const IMPORT_BUTTON_ID = "messageFilterExporter-importButton";
const FILTER_LIST_ID = "filterList";
const FILTER_FILE_START = /^version="\d+"/;
const OVERWRITE_BUTTON = 0;
const SKIP_BUTTON = 2;

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// The email address of the account, or its display name for accounts without
// an identity (e.g. Local Folders, feeds).
function accountName(server) {
  return MailServices.accounts.getFirstIdentityForServer(server)?.email || server.prettyName;
}

function pickFile(window, mode, title, defaultString) {
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
      resolve(result == Ci.nsIFilePicker.returnCancel ? null : picker.file);
    });
  });
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
  const prompts = Cc["@mozilla.org/prompter;1"].getService(Ci.nsIPromptService);
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

async function importFilters(window, logic) {
  const filterList = window.gCurrentFilterList;
  const file = await pickFile(window, Ci.nsIFilePicker.modeOpen, "Import Message Filters");
  if (!file) {
    return;
  }
  if (!FILTER_FILE_START.test(await IOUtils.readUTF8(file.path))) {
    throw new Error(`${file.leafName} is not a Thunderbird message filter file.`);
  }

  const folder = filterList.folder;
  const importText = await filterListText(MailServices.filters.OpenFilterList(file, folder, null));
  const existingText = await filterListText(filterList);
  const newFilterBlocks = logic.selectNewFilters(existingText, importText);
  const importedCount = logic.parseFilterFile(importText).filters.length;

  if (newFilterBlocks.length > 0) {
    const header = logic.parseFilterFile(existingText).header;
    const newFilters = await filtersFromText(logic.buildFilterFile(header, newFilterBlocks), folder);
    for (const filter of newFilters) {
      filterList.insertFilterAt(filterList.filterCount, filter);
    }
    filterList.saveToDefaultFile();
    window.rebuildFilterList();
  }
  setStatus(
    window,
    `Imported ${plural(newFilterBlocks.length, "new filter")} from ${file.leafName}, ` +
      `${importedCount - newFilterBlocks.length} already present.`
  );
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
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown || !this.resourceHost) {
      return;
    }
    ExtensionSupport.unregisterWindowListener(WINDOW_LISTENER_ID);
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
