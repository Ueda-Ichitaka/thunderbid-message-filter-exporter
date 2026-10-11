// About me: Unit tests for the pure filter export/import logic in
// src/filterLogic.mjs: export filenames, splitting and joining filter files,
// parsing single filters and their conditions, merging an imported filter
// into a local one, and the texts of the import prompts and report.
// Runs under Node's built-in test runner, with no Thunderbird involved. The
// filter file samples use Thunderbird's native msgFilterRules.dat format.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filenameForFilter,
  exportFilenames,
  parseFilterFile,
  buildFilterFile,
  parseFilterBlock,
  buildFilterBlock,
  parseCondition,
  buildCondition,
  filterDisplayName,
  describeFolderUri,
  describeRunWhen,
  mergeFilterBlocks,
  prepareNewFilter,
  otherAccountInFilename,
  conflictQuestion,
  importReport,
  importStatus,
  editorNote,
} from "../../src/filterLogic.mjs";

const HEADER = 'version="9"\nlogging="no"\n';

function filterBlock({
  name = "Move newsletters",
  enabled = "yes",
  type = "17",
  action = 'action="Move to folder"\nactionValue="imap://a%40b@imap.b/Newsletters"\n',
  condition = 'condition="AND (subject,contains,newsletter)"\n',
} = {}) {
  return `name="${name}"\nenabled="${enabled}"\ntype="${type}"\n${action}${condition}`;
}

test("filenameForFilter combines account, filter name and MessageFilters", () => {
  assert.equal(
    filenameForFilter("user@example.com", "Move newsletters"),
    "user@example.com_Move newsletters_MessageFilters.dat"
  );
});

test("filenameForFilter accepts an account name without an email address", () => {
  assert.equal(
    filenameForFilter("Local Folders", "Spam"),
    "Local Folders_Spam_MessageFilters.dat"
  );
});

test("filenameForFilter replaces filesystem-unsafe characters in both parts", () => {
  assert.equal(
    filenameForFilter('weird/na*me:"you?<r>|@example.com', 'a/b\\c:d*e?f"g<h>i|j'),
    "weird_na_me__you__r__@example.com_a_b_c_d_e_f_g_h_i_j_MessageFilters.dat"
  );
});

test("filenameForFilter replaces control characters", () => {
  assert.equal(
    filenameForFilter("user@example.com", "tab\there\u0000"),
    "user@example.com_tab_here__MessageFilters.dat"
  );
});

test("filenameForFilter keeps non-ASCII characters", () => {
  assert.equal(
    filenameForFilter("jürgen@example.de", "Rechnungen für März"),
    "jürgen@example.de_Rechnungen für März_MessageFilters.dat"
  );
});

test("exportFilenames returns one filename per filter, in order", () => {
  assert.deepEqual(exportFilenames("user@example.com", ["Spam", "News"]), [
    "user@example.com_Spam_MessageFilters.dat",
    "user@example.com_News_MessageFilters.dat",
  ]);
});

test("exportFilenames numbers filters that share a name so no file is written twice", () => {
  assert.deepEqual(exportFilenames("user@example.com", ["Spam", "News", "Spam", "Spam"]), [
    "user@example.com_Spam_MessageFilters.dat",
    "user@example.com_News_MessageFilters.dat",
    "user@example.com_Spam (2)_MessageFilters.dat",
    "user@example.com_Spam (3)_MessageFilters.dat",
  ]);
});

test("exportFilenames numbers names that only become equal after sanitizing", () => {
  assert.deepEqual(exportFilenames("user@example.com", ["a/b", "a:b"]), [
    "user@example.com_a_b_MessageFilters.dat",
    "user@example.com_a_b (2)_MessageFilters.dat",
  ]);
});

test("parseFilterFile splits the header from the filter blocks", () => {
  const first = filterBlock({ name: "First" });
  const second = filterBlock({ name: "Second" });
  assert.deepEqual(parseFilterFile(HEADER + first + second), {
    header: HEADER,
    filters: [first, second],
  });
});

test("parseFilterFile returns no filters for a file with only a header", () => {
  assert.deepEqual(parseFilterFile(HEADER), { header: HEADER, filters: [] });
});

test("parseFilterFile treats CRLF line endings like LF", () => {
  const block = filterBlock();
  const crlfText = (HEADER + block).replace(/\n/g, "\r\n");
  assert.deepEqual(parseFilterFile(crlfText), { header: HEADER, filters: [block] });
});

test("parseFilterFile keeps escaped quotes inside filter names", () => {
  const block = filterBlock({ name: 'Say \\"hi\\"' });
  assert.deepEqual(parseFilterFile(HEADER + block).filters, [block]);
});

test("parseFilterFile adds a missing trailing newline to the last filter", () => {
  const block = filterBlock();
  assert.deepEqual(parseFilterFile(HEADER + block.trimEnd()).filters, [block]);
});

test("buildFilterFile joins a header and filter blocks back into a file", () => {
  const first = filterBlock({ name: "First" });
  const second = filterBlock({ name: "Second" });
  assert.equal(buildFilterFile(HEADER, [first, second]), HEADER + first + second);
});

test("exportFilenames never reuses a name, even one a filter already has", () => {
  assert.deepEqual(exportFilenames("u", ["Spam", "Spam (2)", "Spam"]), [
    "u_Spam_MessageFilters.dat",
    "u_Spam (2)_MessageFilters.dat",
    "u_Spam (3)_MessageFilters.dat",
  ]);
});

// Merging and import

const MOVE_A = 'action="Move to folder"\nactionValue="imap://a%40b@imap.b/Newsletters"\n';
const MOVE_C = 'action="Move to folder"\nactionValue="imap://c%40d@imap.d/INBOX/News"\n';

function condition(text) {
  return `condition="${text}"\n`;
}

// A resolve callback that answers conflicts from a list and records them.
function answering(...answers) {
  const asked = [];
  const resolve = (conflict) => {
    asked.push(conflict);
    return answers.shift() ?? null;
  };
  return { asked, resolve };
}

function neverAsked(conflict) {
  throw new Error(`Unexpected conflict: ${JSON.stringify(conflict)}`);
}

test("parseFilterBlock splits a filter into settings, actions and condition", () => {
  const block = filterBlock({ action: MOVE_A + 'action="Mark read"\n' });
  assert.deepEqual(parseFilterBlock(block), {
    settings: [
      ["name", "Move newsletters"],
      ["enabled", "yes"],
      ["type", "17"],
    ],
    actions: [
      { type: "Move to folder", value: "imap://a%40b@imap.b/Newsletters" },
      { type: "Mark read" },
    ],
    condition: "AND (subject,contains,newsletter)",
  });
});

test("parseFilterBlock keeps the custom id of custom actions", () => {
  const block = filterBlock({
    action: 'action="Custom"\ncustomId="addon@example.com#run"\nactionValue="x"\n',
  });
  assert.deepEqual(parseFilterBlock(block).actions, [
    { type: "Custom", customId: "addon@example.com#run", value: "x" },
  ]);
});

test("buildFilterBlock writes a parsed filter back unchanged", () => {
  const blocks = [
    filterBlock({ action: MOVE_A + 'action="Mark read"\n' }),
    filterBlock({ action: 'action="Custom"\ncustomId="addon@example.com#run"\nactionValue="x"\n' }),
    'name="Described"\nenabled="no"\ndescription="text"\ntype="1"\naction="Delete"\ncondition="ALL"\n',
  ];
  for (const block of blocks) {
    assert.equal(buildFilterBlock(parseFilterBlock(block)), block);
  }
});

test("filterDisplayName returns the unescaped filter name", () => {
  assert.equal(filterDisplayName(filterBlock({ name: 'Say \\"hi\\"' })), 'Say "hi"');
});

test("parseCondition splits a condition into terms with their boolean operator", () => {
  assert.deepEqual(parseCondition("OR (from,contains,a) OR (subject,is,b c)"), {
    all: false,
    terms: [
      { bool: "OR", text: "from,contains,a" },
      { bool: "OR", text: "subject,is,b c" },
    ],
  });
});

test("parseCondition recognizes a filter that matches all messages", () => {
  assert.deepEqual(parseCondition("ALL"), { all: true, terms: [] });
});

test("parseCondition handles quoted values, custom headers and inner quotes", () => {
  const text =
    'AND (subject,contains,\\"a)b\\") AND (\\"x-custom\\",is,v) AND (body,contains,say \\\\"hi\\\\")';
  assert.deepEqual(parseCondition(text).terms, [
    { bool: "AND", text: 'subject,contains,"a)b"' },
    { bool: "AND", text: '"x-custom",is,v' },
    { bool: "AND", text: 'body,contains,say \\"hi\\"' },
  ]);
  assert.equal(buildCondition(parseCondition(text)), text);
});

test("buildCondition writes ALL for a filter that matches all messages", () => {
  assert.equal(buildCondition({ all: true, terms: [] }), "ALL");
});

test("describeFolderUri shows the folder path and the account part of a folder URI", () => {
  assert.equal(describeFolderUri("imap://a%40b.de@imap.b.de/INBOX/Rechnungen%20M%C3%A4rz"), "INBOX/Rechnungen März (a@b.de@imap.b.de)");
  assert.equal(describeFolderUri("mailbox://nobody@Local%20Folders/Trash"), "Trash (nobody@Local Folders)");
});

test("describeRunWhen names the events a filter type runs on", () => {
  assert.equal(describeRunWhen("17"), "manually, when getting new mail");
  assert.equal(describeRunWhen("16"), "manually");
  assert.equal(describeRunWhen("33"), "when getting new mail after junk classification");
  assert.equal(describeRunWhen("464"), "manually, after sending, when archiving, periodically");
});

test("mergeFilterBlocks reports an identical filter as unchanged, ignoring enabled", () => {
  const result = mergeFilterBlocks(filterBlock(), filterBlock({ enabled: "no" }), neverAsked);
  assert.equal(result.changed, false);
  assert.equal(result.cancelled, false);
});

test("mergeFilterBlocks adds conditions that are only in the file and keeps local ones", () => {
  const local = filterBlock({ condition: condition("OR (from,contains,a) OR (from,contains,b)") });
  const file = filterBlock({ condition: condition("OR (from,contains,b) OR (from,contains,c)") });
  const result = mergeFilterBlocks(local, file, neverAsked);
  assert.equal(result.changed, true);
  assert.equal(result.addedConditions, 1);
  assert.equal(
    parseFilterBlock(result.block).condition,
    "OR (from,contains,a) OR (from,contains,b) OR (from,contains,c)"
  );
});

test("mergeFilterBlocks asks when a condition has the same field and value but another operator", () => {
  const local = filterBlock({ condition: condition("OR (from,is,a@b.de) OR (from,contains,x)") });
  const file = filterBlock({ condition: condition("OR (from,contains,a@b.de)") });

  const keepLocal = answering("local");
  const kept = mergeFilterBlocks(local, file, keepLocal.resolve);
  assert.deepEqual(keepLocal.asked, [
    { kind: "condition", local: "from is a@b.de", file: "from contains a@b.de" },
  ]);
  assert.equal(kept.changed, false);

  const useFile = answering("file");
  const replaced = mergeFilterBlocks(local, file, useFile.resolve);
  assert.equal(parseFilterBlock(replaced.block).condition, "OR (from,contains,a@b.de) OR (from,contains,x)");
  assert.deepEqual(replaced.decisions, [{ conflict: useFile.asked[0], choice: "file" }]);
});

test("mergeFilterBlocks asks when the conditions are combined differently", () => {
  const local = filterBlock({ condition: condition("AND (from,contains,a) AND (subject,contains,b)") });
  const file = filterBlock({ condition: condition("OR (from,contains,c) OR (subject,contains,d)") });
  const { asked, resolve } = answering("file");
  const result = mergeFilterBlocks(local, file, resolve);
  assert.deepEqual(asked, [{ kind: "match", local: "all conditions", file: "any condition" }]);
  assert.equal(
    parseFilterBlock(result.block).condition,
    "OR (from,contains,a) OR (subject,contains,b) OR (from,contains,c) OR (subject,contains,d)"
  );
});

test("mergeFilterBlocks takes the combination of the side with several conditions without asking", () => {
  const local = filterBlock({ condition: condition("AND (from,contains,a)") });
  const file = filterBlock({ condition: condition("OR (from,contains,b) OR (from,contains,c)") });
  const result = mergeFilterBlocks(local, file, neverAsked);
  assert.equal(
    parseFilterBlock(result.block).condition,
    "OR (from,contains,a) OR (from,contains,b) OR (from,contains,c)"
  );
});

test("mergeFilterBlocks keeps the local combination when both sides have one condition", () => {
  const local = filterBlock({ condition: condition("AND (from,contains,a)") });
  const file = filterBlock({ condition: condition("OR (from,contains,b)") });
  const result = mergeFilterBlocks(local, file, neverAsked);
  assert.equal(parseFilterBlock(result.block).condition, "AND (from,contains,a) AND (from,contains,b)");
});

test("mergeFilterBlocks asks between matching all messages and conditions", () => {
  const local = filterBlock({ condition: condition("ALL") });
  const file = filterBlock({ condition: condition("OR (from,contains,b) OR (from,contains,c)") });

  const keepAll = answering("local");
  const kept = mergeFilterBlocks(local, file, keepAll.resolve);
  assert.deepEqual(keepAll.asked, [{ kind: "match", local: "all messages", file: "any condition" }]);
  assert.equal(kept.changed, false);

  const useFile = answering("file");
  const replaced = mergeFilterBlocks(local, file, useFile.resolve);
  assert.equal(parseFilterBlock(replaced.block).condition, "OR (from,contains,b) OR (from,contains,c)");
});

test("mergeFilterBlocks asks when the filter runs at different times", () => {
  const { asked, resolve } = answering("file");
  const result = mergeFilterBlocks(filterBlock({ type: "17" }), filterBlock({ type: "16" }), resolve);
  assert.deepEqual(asked, [
    { kind: "runWhen", local: "manually, when getting new mail", file: "manually" },
  ]);
  assert.deepEqual(parseFilterBlock(result.block).settings[2], ["type", "16"]);
});

test("mergeFilterBlocks keeps the local enabled state and description", () => {
  const local = 'name="F"\nenabled="no"\ndescription="mine"\ntype="17"\naction="Mark read"\ncondition="AND (from,contains,a)"\n';
  const file = 'name="F"\nenabled="yes"\ndescription="theirs"\ntype="17"\naction="Mark read"\ncondition="AND (from,contains,b)"\n';
  const settings = parseFilterBlock(mergeFilterBlocks(local, file, neverAsked).block).settings;
  assert.deepEqual(settings, [
    ["name", "F"],
    ["enabled", "no"],
    ["description", "mine"],
    ["type", "17"],
  ]);
});

test("mergeFilterBlocks adds actions that are only in the file", () => {
  const local = filterBlock({ action: 'action="Mark read"\n' });
  const file = filterBlock({ action: 'action="Mark read"\naction="Mark flagged"\naction="AddTag"\nactionValue="$label1"\n' });
  const result = mergeFilterBlocks(local, file, neverAsked);
  assert.equal(result.addedActions, 2);
  assert.deepEqual(parseFilterBlock(result.block).actions, [
    { type: "Mark read" },
    { type: "Mark flagged" },
    { type: "AddTag", value: "$label1" },
  ]);
});

test("mergeFilterBlocks keeps repeatable actions with other values side by side", () => {
  const local = filterBlock({ action: 'action="AddTag"\nactionValue="$label1"\naction="Forward"\nactionValue="x@y.de"\n' });
  const file = filterBlock({ action: 'action="AddTag"\nactionValue="$label2"\naction="Forward"\nactionValue="x@y.de"\n' });
  const result = mergeFilterBlocks(local, file, neverAsked);
  assert.deepEqual(parseFilterBlock(result.block).actions, [
    { type: "AddTag", value: "$label1" },
    { type: "Forward", value: "x@y.de" },
    { type: "AddTag", value: "$label2" },
  ]);
});

test("mergeFilterBlocks asks when a single-use action has another value", () => {
  const local = filterBlock({ action: MOVE_A + 'action="Change priority"\nactionValue="High"\n' });
  const file = filterBlock({ action: MOVE_A + 'action="Change priority"\nactionValue="Low"\n' });
  const { asked, resolve } = answering("file");
  const result = mergeFilterBlocks(local, file, resolve);
  assert.deepEqual(asked, [{ kind: "action", local: "Change priority High", file: "Change priority Low" }]);
  assert.deepEqual(parseFilterBlock(result.block).actions[1], { type: "Change priority", value: "Low" });
});

test("mergeFilterBlocks asks between Move and Delete, which exclude each other", () => {
  const local = filterBlock({ action: 'action="Delete"\n' });
  const file = filterBlock({ action: MOVE_A });
  const { asked, resolve } = answering("local");
  const result = mergeFilterBlocks(local, file, resolve);
  assert.deepEqual(asked, [
    { kind: "action", local: "Delete", file: "Move to folder Newsletters (a@b@imap.b)" },
  ]);
  assert.equal(result.changed, false);
});

test("mergeFilterBlocks asks between Mark read and Mark unread", () => {
  const { asked, resolve } = answering("file");
  const result = mergeFilterBlocks(
    filterBlock({ action: 'action="Mark read"\n' }),
    filterBlock({ action: 'action="Mark unread"\n' }),
    resolve
  );
  assert.equal(asked.length, 1);
  assert.deepEqual(parseFilterBlock(result.block).actions, [{ type: "Mark unread" }]);
});

test("mergeFilterBlocks uses describeFolder for folder actions in questions", () => {
  const { asked, resolve } = answering("local");
  mergeFilterBlocks(filterBlock({ action: MOVE_A }), filterBlock({ action: MOVE_C }), resolve, {
    describeFolder: (uri) => `<${uri}>`,
  });
  assert.deepEqual(asked, [
    {
      kind: "action",
      local: "Move to folder <imap://a%40b@imap.b/Newsletters>",
      file: "Move to folder <imap://c%40d@imap.d/INBOX/News>",
    },
  ]);
});

test("mergeFilterBlocks clears the folder of every Move/Copy action taken from the file", () => {
  const local = filterBlock({ action: MOVE_A });
  const file = filterBlock({
    action: MOVE_C + 'action="Copy to folder"\nactionValue="imap://c%40d@imap.d/Archive"\n',
  });
  const { resolve } = answering("file");
  const result = mergeFilterBlocks(local, file, resolve);
  assert.deepEqual(parseFilterBlock(result.block).actions, [
    { type: "Move to folder" },
    { type: "Copy to folder" },
  ]);
  assert.deepEqual(result.reselect, [
    { action: "Move to folder", previous: "imap://c%40d@imap.d/INBOX/News" },
    { action: "Copy to folder", previous: "imap://c%40d@imap.d/Archive" },
  ]);
});

test("mergeFilterBlocks leaves local folder actions alone and asks for nothing when they are equal", () => {
  const result = mergeFilterBlocks(
    filterBlock({ action: MOVE_A, condition: condition("AND (from,contains,a)") }),
    filterBlock({ action: MOVE_A, condition: condition("AND (from,contains,b)") }),
    neverAsked
  );
  assert.deepEqual(result.reselect, []);
  assert.deepEqual(parseFilterBlock(result.block).actions, [
    { type: "Move to folder", value: "imap://a%40b@imap.b/Newsletters" },
  ]);
});

test("mergeFilterBlocks clears the template of a Reply action taken from the file", () => {
  const result = mergeFilterBlocks(
    filterBlock({ action: 'action="Mark read"\n' }),
    filterBlock({ action: 'action="Reply"\nactionValue="mailbox-message://x@y/Templates#1"\n' }),
    neverAsked
  );
  assert.deepEqual(parseFilterBlock(result.block).actions, [{ type: "Mark read" }, { type: "Reply" }]);
  assert.deepEqual(result.reselect, [{ action: "Reply", previous: "mailbox-message://x@y/Templates#1" }]);
});

test("mergeFilterBlocks stops without a result when a question is cancelled", () => {
  const { resolve } = answering(null);
  const result = mergeFilterBlocks(filterBlock({ type: "17" }), filterBlock({ type: "16" }), resolve);
  assert.deepEqual(result, { cancelled: true });
});

test("prepareNewFilter clears folder and template targets and lists them", () => {
  const result = prepareNewFilter(filterBlock({ action: MOVE_C + 'action="Mark read"\n' }));
  assert.deepEqual(parseFilterBlock(result.block).actions, [{ type: "Move to folder" }, { type: "Mark read" }]);
  assert.deepEqual(result.reselect, [{ action: "Move to folder", previous: "imap://c%40d@imap.d/INBOX/News" }]);
});

test("prepareNewFilter keeps a filter without folder actions as it is", () => {
  const block = filterBlock({ action: 'action="Mark read"\n' });
  assert.deepEqual(prepareNewFilter(block), { block, reselect: [] });
});

test("otherAccountInFilename returns nothing for files of the current account", () => {
  assert.equal(otherAccountInFilename("a@b.de_Spam_MessageFilters.dat", "a@b.de"), null);
  assert.equal(otherAccountInFilename("a@b.de_MessageFilters.dat", "a@b.de"), null);
  assert.equal(otherAccountInFilename("Local Folders_Spam_MessageFilters.dat", "Local Folders"), null);
});

test("otherAccountInFilename returns the account of a file exported from another account", () => {
  assert.equal(otherAccountInFilename("x_y@c.de_My_Filter_MessageFilters.dat", "a@b.de"), "x_y@c.de");
  assert.equal(otherAccountInFilename("x@c.de_MessageFilters.dat", "a@b.de"), "x@c.de");
  assert.equal(otherAccountInFilename("Local Folders_Spam_MessageFilters.dat", "a@b.de"), "Local Folders_Spam");
});

test("otherAccountInFilename returns nothing for files not named by the exporter", () => {
  assert.equal(otherAccountInFilename("msgFilterRules.dat", "a@b.de"), null);
});

test("otherAccountInFilename compares with the account name as it appears in filenames", () => {
  assert.equal(otherAccountInFilename("a_b_Spam_MessageFilters.dat", "a/b"), null);
});

test("conflictQuestion names the filter, the file, the difference and both sides", () => {
  assert.equal(
    conflictQuestion("Spam", "x.dat", { kind: "runWhen", local: "manually", file: "periodically" }),
    'The imported filter "Spam" from x.dat differs from your local filter "Spam" in when the filter runs.\n\n' +
      "Local: manually\nFile: periodically\n\nWhich one should the merged filter keep?"
  );
});

test("importStatus counts the results of all files", () => {
  const results = [
    { file: "a.dat", filters: [{ name: "A", outcome: "added" }, { name: "B", outcome: "merged" }] },
    { file: "b.dat", filters: [{ name: "C", outcome: "present" }, { name: "D", outcome: "skipped" }] },
  ];
  assert.equal(importStatus(results), "Imported 2 files: 1 added, 1 merged, 1 already present, 1 skipped.");
  assert.equal(
    importStatus([results[0]]),
    "Imported a.dat: 1 added, 1 merged, 0 already present, 0 skipped."
  );
});

test("importReport lists every file with its filters, merge decisions and warnings", () => {
  const report = importReport("a@b.de", [
    {
      file: "x@c.de_Spam_MessageFilters.dat",
      otherAccount: "x@c.de",
      filters: [
        {
          name: "Spam",
          outcome: "merged",
          addedConditions: 2,
          addedActions: 1,
          decisions: [
            { conflict: { kind: "condition", local: "from is a", file: "from contains a" }, choice: "file" },
            { conflict: { kind: "runWhen", local: "manually", file: "periodically" }, choice: "local" },
          ],
        },
      ],
    },
    { file: "new.dat", filters: [{ name: "New", outcome: "added" }, { name: "Old", outcome: "present" }, { name: "No", outcome: "skipped" }] },
    { file: "bad.txt", error: "bad.txt is not a Thunderbird message filter file.", filters: [] },
  ]);
  assert.equal(
    report,
    [
      "x@c.de_Spam_MessageFilters.dat",
      '  Warning: this file was exported from the account "x@c.de", not from "a@b.de". Its filters were imported anyway.',
      '  Merged into the existing filter "Spam": added 2 conditions and 1 action.',
      "    Condition: used the file's from contains a instead of from is a.",
      "    When the filter runs: kept the local manually instead of periodically.",
      "new.dat",
      '  Added the filter "New".',
      '  The filter "Old" is already present.',
      '  Skipped the filter "No".',
      "bad.txt",
      "  Not imported: bad.txt is not a Thunderbird message filter file.",
    ].join("\n")
  );
});

test("editorNote asks to choose the targets again and shows the previous ones", () => {
  assert.equal(
    editorNote("x.dat", [
      { action: "Move to folder", previous: "INBOX/Invoices (a@b.de@imap.b.de)" },
      { action: "Reply", previous: "" },
    ]),
    "Imported from x.dat. Choose the target of these actions again, so that no mail goes to a " +
      "folder or template of another account:\n" +
      "  Move to folder - previously INBOX/Invoices (a@b.de@imap.b.de)\n" +
      "  Reply - previously not set"
  );
});
