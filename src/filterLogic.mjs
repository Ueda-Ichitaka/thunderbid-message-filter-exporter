// About me: Pure, Thunderbird-independent logic for the message filter exporter.
// Builds export filenames per filter and works on the text of Thunderbird's
// native filter file format (msgFilterRules.dat): splitting it into one text
// block per filter and joining blocks back into a file, parsing a filter into
// settings, actions and condition terms, merging an imported filter into a
// local filter of the same name, and writing the texts of the import
// questions and report. Nothing here touches Thunderbird/XPCOM, so it can be
// unit tested with the plain Node.js test runner.

const FILESYSTEM_UNSAFE_CHARACTERS = /[/\\:*?"<>|\u0000-\u001f]/g;
const FILTER_START_LINE = /^name="/;
const ATTRIBUTE_LINE = /^([A-Za-z]+)="(.*)"$/;
const EXPORT_SUFFIX = "_MessageFilters.dat";

function sanitizeForFilename(text) {
  return text.replace(FILESYSTEM_UNSAFE_CHARACTERS, "_");
}

// The account name is the email address of the account, or the account's
// display name for accounts without an email address (e.g. Local Folders).
export function filenameForFilter(accountName, filterName) {
  return `${sanitizeForFilename(accountName)}_${sanitizeForFilename(filterName)}_MessageFilters.dat`;
}

// One export filename per filter, in order. A filter whose name (after
// sanitizing) is already taken gets the lowest free " (2)", " (3)", ...
// so that no file is written twice in one export.
export function exportFilenames(accountName, filterNames) {
  const usedNames = new Set();
  return filterNames.map((filterName) => {
    const sanitizedName = sanitizeForFilename(filterName);
    let uniqueName = sanitizedName;
    for (let number = 2; usedNames.has(uniqueName); number++) {
      uniqueName = `${sanitizedName} (${number})`;
    }
    usedNames.add(uniqueName);
    return filenameForFilter(accountName, uniqueName);
  });
}

// Splits a filter file into its header (version, logging) and one text block
// per filter. Each filter block starts with its name= line and ends with a
// newline. Line endings are normalized to LF.
export function parseFilterFile(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  let header = "";
  const filters = [];
  for (const line of lines) {
    if (FILTER_START_LINE.test(line)) {
      filters.push("");
    }
    if (filters.length === 0) {
      header += `${line}\n`;
    } else {
      filters[filters.length - 1] += `${line}\n`;
    }
  }
  return { header, filters };
}

export function buildFilterFile(header, filters) {
  return header + filters.join("");
}

// Actions a filter may contain more than once; every other action can appear
// only once per filter (as in Thunderbird's filter editor).
const REPEATABLE_ACTIONS = new Set(["Copy to folder", "AddTag", "Forward"]);
// Actions that make no sense together, so the filter editor allows only one.
const EXCLUSIVE_ACTIONS = new Map([
  ["Move to folder", "Delete"],
  ["Delete", "Move to folder"],
  ["Mark read", "Mark unread"],
  ["Mark unread", "Mark read"],
]);
// Actions whose value points into one account (a folder or a template
// message), so their target has to be chosen again after an import.
const ACCOUNT_BOUND_ACTIONS = new Set(["Move to folder", "Copy to folder", "Reply"]);
const FOLDER_ACTIONS = new Set(["Move to folder", "Copy to folder"]);

// nsMsgFilterType bits of the type= line and how the filter editor calls them.
const MANUAL = 0x10;
const INCOMING = 0x01 | 0x04;
const POST_PLUGIN = 0x20;
const RUN_WHEN_LATER = [
  [0x40, "after sending"],
  [0x80, "when archiving"],
  [0x100, "periodically"],
];

const MODE_DESCRIPTIONS = { ALL: "all messages", AND: "all conditions", OR: "any condition" };
const CONFLICT_SUBJECTS = {
  match: "how its conditions are combined",
  runWhen: "when the filter runs",
  condition: "a condition",
  action: "an action",
};
const CONFLICT_LABELS = {
  match: "Combining conditions",
  runWhen: "When the filter runs",
  condition: "Condition",
  action: "Action",
};

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// Attribute values in the filter file escape double quotes with a backslash.
function unescapeQuotes(text) {
  return text.replace(/\\"/g, '"');
}

function escapeQuotes(text) {
  return text.replace(/"/g, '\\"');
}

// Splits one filter block into its settings (name, enabled, description,
// type, ... in file order), its actions ({ type, customId?, value? }) and its
// condition line. Values stay escaped as in the file.
export function parseFilterBlock(block) {
  const parsed = { settings: [], actions: [], condition: null };
  for (const line of block.split("\n")) {
    if (line === "") {
      continue;
    }
    const match = ATTRIBUTE_LINE.exec(line);
    const [key, value] = match ? [match[1], match[2]] : [line, undefined];
    const lastAction = parsed.actions.at(-1);
    if (key === "action") {
      parsed.actions.push({ type: value });
    } else if (key === "customId" && lastAction) {
      lastAction.customId = value;
    } else if (key === "actionValue" && lastAction) {
      lastAction.value = value;
    } else if (key === "condition") {
      parsed.condition = value;
    } else {
      parsed.settings.push(value === undefined ? [key] : [key, value]);
    }
  }
  return parsed;
}

export function buildFilterBlock({ settings, actions, condition }) {
  const lines = settings.map(([key, value]) => (value === undefined ? key : `${key}="${value}"`));
  for (const action of actions) {
    lines.push(`action="${action.type}"`);
    if (action.customId !== undefined) {
      lines.push(`customId="${action.customId}"`);
    }
    if (action.value !== undefined) {
      lines.push(`actionValue="${action.value}"`);
    }
  }
  if (condition !== null) {
    lines.push(`condition="${condition}"`);
  }
  return lines.map((line) => `${line}\n`).join("");
}

function setting(parsed, key) {
  return parsed.settings.find(([name]) => name === key)?.[1];
}

export function filterDisplayName(block) {
  return unescapeQuotes(setting(parseFilterBlock(block), "name") ?? "");
}

// Splits the value of a condition= line into terms, the way Thunderbird's
// nsMsgFilterList::ParseCondition does: each term is in parentheses, preceded
// by AND or OR; a ")" inside a quoted value does not end the term. "ALL"
// means the filter matches all messages. Term texts are unescaped once (as
// Thunderbird reads them), so buildCondition can write them back unchanged.
export function parseCondition(text) {
  if (text === "ALL") {
    return { all: true, terms: [] };
  }
  const unescaped = unescapeQuotes(text);
  const terms = [];
  let position = 0;
  for (;;) {
    const open = unescaped.indexOf("(", position);
    if (open < 0) {
      break;
    }
    const bool = unescaped.slice(position, open).includes("O") ? "OR" : "AND";
    let inQuote = false;
    let end = open + 1;
    for (; end < unescaped.length; end++) {
      const character = unescaped[end];
      if (character === "\\" && unescaped[end + 1] === '"') {
        end++;
      } else if (character === ")" && !inQuote) {
        break;
      } else if (character === '"') {
        inQuote = !inQuote;
      }
    }
    if (end >= unescaped.length) {
      break;
    }
    terms.push({ bool, text: unescaped.slice(open + 1, end) });
    position = end + 1;
  }
  return { all: false, terms };
}

export function buildCondition({ all, terms }) {
  if (all) {
    return "ALL";
  }
  return terms.map(({ bool, text }) => `${bool} (${escapeQuotes(text)})`).join(" ");
}

// A term text is "field,operator,value"; the value may contain commas.
function splitTerm(text) {
  const first = text.indexOf(",");
  const second = text.indexOf(",", first + 1);
  if (first < 0 || second < 0) {
    return [text, "", ""];
  }
  return [text.slice(0, first), text.slice(first + 1, second), text.slice(second + 1)];
}

function describeTerm(text) {
  return splitTerm(text).join(" ").trim();
}

function decodeUriPart(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// "imap://a%40b.de@imap.b.de/INBOX/Sub" -> "INBOX/Sub (a@b.de@imap.b.de)"
export function describeFolderUri(uri) {
  const match = /^[A-Za-z-]+:\/\/([^/]*)\/?(.*)$/.exec(uri);
  if (!match) {
    return uri;
  }
  return `${decodeUriPart(match[2])} (${decodeUriPart(match[1])})`;
}

export function describeRunWhen(type) {
  const bits = Number(type);
  const events = [];
  if (bits & MANUAL) {
    events.push("manually");
  }
  if (bits & POST_PLUGIN) {
    events.push("when getting new mail after junk classification");
  } else if (bits & INCOMING) {
    events.push("when getting new mail");
  }
  for (const [bit, text] of RUN_WHEN_LATER) {
    if (bits & bit) {
      events.push(text);
    }
  }
  return events.length ? events.join(", ") : "never";
}

function describeAction(action, describeFolder) {
  const parts = [action.type];
  if (action.customId !== undefined) {
    parts.push(action.customId);
  }
  if (action.value !== undefined) {
    parts.push(FOLDER_ACTIONS.has(action.type) ? describeFolder(unescapeQuotes(action.value)) : unescapeQuotes(action.value));
  }
  return parts.join(" ");
}

function actionKey(action) {
  return action.type === "Custom" ? `Custom ${action.customId}` : action.type;
}

function sameAction(a, b) {
  return a.type === b.type && a.customId === b.customId && a.value === b.value;
}

// "ALL", "AND" or "OR" when the condition says how terms are combined; null
// for a single term, where AND and OR mean the same.
function conditionMode(condition) {
  if (condition.all) {
    return "ALL";
  }
  return condition.terms.length >= 2 ? condition.terms[0].bool : null;
}

// Like conditionMode, but also reads the operator of a single term.
function writtenMode(condition) {
  return condition.all ? "ALL" : condition.terms[0]?.bool ?? null;
}

// Removes the values of account-bound actions (folders, reply templates) and
// returns what they were, so the user can choose the targets again.
function clearAccountTargets(actions) {
  const reselect = [];
  for (const action of actions) {
    if (ACCOUNT_BOUND_ACTIONS.has(action.type)) {
      reselect.push({ action: action.type, previous: action.value ?? "" });
      delete action.value;
    }
  }
  return reselect;
}

const CANCELLED = Symbol("cancelled");

// Merges an imported filter (fileBlock) into the local filter of the same
// name (localBlock):
// - Conditions and actions only in the file are added, local ones are kept.
// - resolve(conflict) is asked about every difference that cannot be
//   combined and returns "local" or "file" (anything else cancels the merge):
//   how conditions are combined (match), when the filter runs (runWhen), a
//   condition with the same field and value but another operator
//   (condition), and a single-use action with another value or an action
//   that excludes a local one (action). A conflict is { kind, local, file }
//   with readable descriptions of both sides; describeFolder describes
//   folder URIs in them.
// - The local enabled state and description are kept.
// - Move/Copy/Reply actions taken from the file lose their target, listed in
//   reselect ({ action, previous }), so the user chooses it again.
// Returns { cancelled: false, changed, block, addedConditions, addedActions,
// decisions: [{ conflict, choice }], reselect }, or { cancelled: true }.
export function mergeFilterBlocks(localBlock, fileBlock, resolve, { describeFolder = describeFolderUri } = {}) {
  const local = parseFilterBlock(localBlock);
  const file = parseFilterBlock(fileBlock);
  const decisions = [];
  const ask = (conflict) => {
    const choice = resolve(conflict);
    if (choice !== "local" && choice !== "file") {
      throw CANCELLED;
    }
    decisions.push({ conflict, choice });
    return choice;
  };

  try {
    const settings = local.settings.map((entry) => [...entry]);
    const localType = setting(local, "type");
    const fileType = setting(file, "type");
    if (fileType !== undefined && localType !== undefined && fileType !== localType) {
      const choice = ask({ kind: "runWhen", local: describeRunWhen(localType), file: describeRunWhen(fileType) });
      if (choice === "file") {
        settings.find(([key]) => key === "type")[1] = fileType;
      }
    }

    const { condition, addedConditions } = mergeConditions(local.condition, file.condition, ask);
    const { actions, fromFile, addedActions } = mergeActions(local.actions, file.actions, ask, describeFolder);

    const merged = { settings, actions, condition };
    // Compared before targets are cleared: an action taken from the file
    // always changes the filter, even when its cleared target is chosen again.
    const changed = buildFilterBlock(merged) !== localBlock;
    const reselect = clearAccountTargets(actions.filter((action) => fromFile.has(action)));
    return {
      cancelled: false,
      changed,
      block: buildFilterBlock(merged),
      addedConditions,
      addedActions,
      decisions,
      reselect,
    };
  } catch (error) {
    if (error === CANCELLED) {
      return { cancelled: true };
    }
    throw error;
  }
}

function mergeConditions(localText, fileText, ask) {
  const local = parseCondition(localText ?? "");
  const file = parseCondition(fileText ?? "");
  const localMode = conditionMode(local);
  const fileMode = conditionMode(file);
  const localWritten = writtenMode(local);
  const fileWritten = writtenMode(file);

  let mode;
  const modesDiffer = localMode && fileMode && localMode !== fileMode;
  const allAgainstTerms =
    (local.all && file.terms.length > 0) || (file.all && local.terms.length > 0);
  if (modesDiffer || allAgainstTerms) {
    const choice = ask({
      kind: "match",
      local: MODE_DESCRIPTIONS[localWritten],
      file: MODE_DESCRIPTIONS[fileWritten],
    });
    mode = choice === "local" ? localWritten : fileWritten;
  } else {
    mode = localMode ?? fileMode ?? localWritten ?? fileWritten;
  }

  if (mode === null) {
    return { condition: localText, addedConditions: 0 };
  }
  if (mode === "ALL") {
    return { condition: "ALL", addedConditions: 0 };
  }

  const terms = local.terms.map((term) => ({ ...term }));
  let addedConditions = 0;
  for (const fileTerm of file.terms) {
    if (terms.some((term) => term.text === fileTerm.text)) {
      continue;
    }
    const [field, operator, value] = splitTerm(fileTerm.text);
    const sameFieldAndValue = terms.findIndex((term) => {
      const [termField, termOperator, termValue] = splitTerm(term.text);
      return termField === field && termValue === value && termOperator !== operator;
    });
    if (sameFieldAndValue >= 0) {
      const choice = ask({
        kind: "condition",
        local: describeTerm(terms[sameFieldAndValue].text),
        file: describeTerm(fileTerm.text),
      });
      if (choice === "file") {
        terms[sameFieldAndValue] = { ...fileTerm };
      }
      continue;
    }
    terms.push({ ...fileTerm });
    addedConditions++;
  }
  for (const term of terms) {
    term.bool = mode;
  }
  return { condition: buildCondition({ all: false, terms }), addedConditions };
}

function mergeActions(localActions, fileActions, ask, describeFolder) {
  const actions = localActions.map((action) => ({ ...action }));
  const fromFile = new Set();
  let addedActions = 0;
  for (const fileAction of fileActions) {
    if (actions.some((action) => sameAction(action, fileAction))) {
      continue;
    }
    const taken = { ...fileAction };
    if (!REPEATABLE_ACTIONS.has(fileAction.type)) {
      const clash = actions.findIndex(
        (action) =>
          actionKey(action) === actionKey(fileAction) ||
          EXCLUSIVE_ACTIONS.get(fileAction.type) === action.type
      );
      if (clash >= 0) {
        const choice = ask({
          kind: "action",
          local: describeAction(actions[clash], describeFolder),
          file: describeAction(fileAction, describeFolder),
        });
        if (choice === "file") {
          actions[clash] = taken;
          fromFile.add(taken);
        }
        continue;
      }
    }
    actions.push(taken);
    fromFile.add(taken);
    addedActions++;
  }
  return { actions, fromFile, addedActions };
}

// An imported filter with no local filter of the same name: its
// Move/Copy/Reply targets are cleared and listed in reselect like in
// mergeFilterBlocks.
export function prepareNewFilter(fileBlock) {
  const parsed = parseFilterBlock(fileBlock);
  const reselect = clearAccountTargets(parsed.actions);
  return { block: reselect.length ? buildFilterBlock(parsed) : fileBlock, reselect };
}

// The account an exported file comes from, if its name (as written by
// filenameForFilter, or <account>_MessageFilters.dat) shows another account
// than accountName; null for files of this account and for other filenames.
// An email address ends at the first "_" after its "@"; for other account
// names the whole part before the suffix is returned, since filter names may
// contain "_" too.
export function otherAccountInFilename(filename, accountName) {
  if (!filename.endsWith(EXPORT_SUFFIX)) {
    return null;
  }
  const stem = filename.slice(0, -EXPORT_SUFFIX.length);
  const prefix = sanitizeForFilename(accountName);
  if (stem === prefix || stem.startsWith(`${prefix}_`)) {
    return null;
  }
  const at = stem.indexOf("@");
  const end = at < 0 ? -1 : stem.indexOf("_", at);
  return end < 0 ? stem : stem.slice(0, end);
}

export function conflictQuestion(filterName, fileName, conflict) {
  return (
    `The imported filter "${filterName}" from ${fileName} differs from your local filter ` +
    `"${filterName}" in ${CONFLICT_SUBJECTS[conflict.kind]}.\n\n` +
    `Local: ${conflict.local}\nFile: ${conflict.file}\n\n` +
    "Which one should the merged filter keep?"
  );
}

function filterReportLines(filter) {
  switch (filter.outcome) {
    case "added":
      return [`  Added the filter "${filter.name}".`];
    case "present":
      return [`  The filter "${filter.name}" is already present.`];
    case "skipped":
      return [`  Skipped the filter "${filter.name}".`];
    case "merged": {
      const added =
        filter.addedConditions || filter.addedActions
          ? `added ${plural(filter.addedConditions, "condition")} and ${plural(filter.addedActions, "action")}`
          : "nothing added";
      return [
        `  Merged into the existing filter "${filter.name}": ${added}.`,
        ...filter.decisions.map(({ conflict, choice }) =>
          choice === "file"
            ? `    ${CONFLICT_LABELS[conflict.kind]}: used the file's ${conflict.file} instead of ${conflict.local}.`
            : `    ${CONFLICT_LABELS[conflict.kind]}: kept the local ${conflict.local} instead of ${conflict.file}.`
        ),
      ];
    }
    default:
      return [];
  }
}

// The text of the import summary dialog. results lists every imported file:
// { file, otherAccount?, error?, filters: [{ name, outcome, addedConditions?,
// addedActions?, decisions? }] } with outcome "added", "merged", "present" or
// "skipped".
export function importReport(accountName, results) {
  const lines = [];
  for (const result of results) {
    lines.push(result.file);
    if (result.otherAccount) {
      lines.push(
        `  Warning: this file was exported from the account "${result.otherAccount}", ` +
          `not from "${accountName}". Its filters were imported anyway.`
      );
    }
    if (result.error) {
      lines.push(`  Not imported: ${result.error}`);
    }
    for (const filter of result.filters) {
      lines.push(...filterReportLines(filter));
    }
  }
  return lines.join("\n");
}

// The one-line import summary for the status bar.
export function importStatus(results) {
  const counts = { added: 0, merged: 0, present: 0, skipped: 0 };
  for (const result of results) {
    for (const filter of result.filters) {
      counts[filter.outcome]++;
    }
  }
  const files = results.length === 1 ? results[0].file : plural(results.length, "file");
  return (
    `Imported ${files}: ${counts.added} added, ${counts.merged} merged, ` +
    `${counts.present} already present, ${counts.skipped} skipped.`
  );
}

// The note shown above the actions in Thunderbird's filter editor when an
// imported filter needs its targets chosen again. targets: [{ action,
// previous }] with a readable description of the previous target.
export function editorNote(fileName, targets) {
  return [
    `Imported from ${fileName}. Choose the target of these actions again, so that no mail goes ` +
      "to a folder or template of another account:",
    ...targets.map(({ action, previous }) => `  ${action} - previously ${previous || "not set"}`),
  ].join("\n");
}
