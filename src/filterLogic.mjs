// About me: Pure, Thunderbird-independent logic for the message filter exporter.
// Builds export filenames per filter and works on the text of Thunderbird's
// native filter file format (msgFilterRules.dat): splitting it into one text
// block per filter, joining blocks back into a file, and picking the imported
// filters that an account does not have yet. Nothing here touches
// Thunderbird/XPCOM, so it can be unit tested with the plain Node.js test runner.

const FILESYSTEM_UNSAFE_CHARACTERS = /[/\\:*?"<>|\u0000-\u001f]/g;
const FILTER_START_LINE = /^name="/;
const ENABLED_LINE = /^enabled="[^"]*"$/;

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

// The identity of a filter is its whole text block without the enabled= line,
// so name, type, conditions, and actions all have to match. The enabled state
// is excluded so that re-importing a filter someone merely switched off
// elsewhere doesn't add it as a second copy.
function filterIdentity(filterBlock) {
  return filterBlock
    .split("\n")
    .filter((line) => !ENABLED_LINE.test(line))
    .join("\n");
}

// Returns the filter blocks of importText that are not present in
// existingText, in import order and each one at most once. Both texts are
// expected to be written by Thunderbird itself, so equal filters have equal
// text.
export function selectNewFilters(existingText, importText) {
  const knownIdentities = new Set(
    parseFilterFile(existingText).filters.map(filterIdentity)
  );
  const newFilters = [];
  for (const filterBlock of parseFilterFile(importText).filters) {
    const identity = filterIdentity(filterBlock);
    if (!knownIdentities.has(identity)) {
      knownIdentities.add(identity);
      newFilters.push(filterBlock);
    }
  }
  return newFilters;
}
