// About me: Unit tests for the pure filter-export logic in src/filterLogic.mjs.
// Runs under Node's built-in test runner, with no Thunderbird involved. The
// filter file samples use Thunderbird's native msgFilterRules.dat format.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filenameForFilter,
  exportFilenames,
  parseFilterFile,
  buildFilterFile,
  selectNewFilters,
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

test("selectNewFilters returns imported filters that are not on the account", () => {
  const existing = HEADER + filterBlock({ name: "Already there" });
  const fresh = filterBlock({ name: "Brand new" });
  const imported = HEADER + filterBlock({ name: "Already there" }) + fresh;
  assert.deepEqual(selectNewFilters(existing, imported), [fresh]);
});

test("selectNewFilters ignores the enabled state", () => {
  const existing = HEADER + filterBlock({ enabled: "yes" });
  const imported = HEADER + filterBlock({ enabled: "no" });
  assert.deepEqual(selectNewFilters(existing, imported), []);
});

test("selectNewFilters treats a different filter name as a new filter", () => {
  const existing = HEADER + filterBlock({ name: "Move newsletters" });
  const imported = HEADER + filterBlock({ name: "Move receipts" });
  assert.equal(selectNewFilters(existing, imported).length, 1);
});

test("selectNewFilters treats a different filter type as a new filter", () => {
  const existing = HEADER + filterBlock({ type: "17" });
  const imported = HEADER + filterBlock({ type: "1" });
  assert.equal(selectNewFilters(existing, imported).length, 1);
});

test("selectNewFilters treats a different condition as a new filter", () => {
  const existing = HEADER + filterBlock();
  const imported =
    HEADER + filterBlock({ condition: 'condition="AND (subject,contains,spam)"\n' });
  assert.equal(selectNewFilters(existing, imported).length, 1);
});

test("selectNewFilters treats a different action as a new filter", () => {
  const existing = HEADER + filterBlock();
  const imported = HEADER + filterBlock({ action: 'action="Mark read"\n' });
  assert.equal(selectNewFilters(existing, imported).length, 1);
});

test("selectNewFilters treats an additional action as a new filter", () => {
  const existing = HEADER + filterBlock({ action: 'action="Mark read"\n' });
  const imported =
    HEADER + filterBlock({ action: 'action="Mark read"\naction="Mark flagged"\n' });
  assert.equal(selectNewFilters(existing, imported).length, 1);
});

test("selectNewFilters returns a filter repeated in the import file only once", () => {
  const block = filterBlock();
  assert.deepEqual(selectNewFilters(HEADER, HEADER + block + block), [block]);
});

test("selectNewFilters keeps the enabled state of the imported filter", () => {
  const disabled = filterBlock({ enabled: "no" });
  assert.deepEqual(selectNewFilters(HEADER, HEADER + disabled), [disabled]);
});

test("exportFilenames never reuses a name, even one a filter already has", () => {
  assert.deepEqual(exportFilenames("u", ["Spam", "Spam (2)", "Spam"]), [
    "u_Spam_MessageFilters.dat",
    "u_Spam (2)_MessageFilters.dat",
    "u_Spam (3)_MessageFilters.dat",
  ]);
});
