# thunderbird-message-filter-exporter

A Thunderbird MailExtension that adds "Export..." and "Import..." buttons to
the built-in Message Filters dialog (Tools > Message Filters), so message
filters can be moved between installs (native or Flatpak) that use the same
mail account.

- **Export** writes each selected filter to its own file named
  `<email-address>_<filter-name>_MessageFilters.dat` (or
  `<account-name>_<filter-name>_MessageFilters.dat` for accounts without an
  email address, such as Local Folders), in Thunderbird's own native filter
  file format (`msgFilterRules.dat`). Select filters with Ctrl/Shift-click;
  Export is disabled while nothing is selected.
  - One selected filter: a Save dialog opens with that filename. It asks
    itself before replacing an existing file.
  - Several selected filters: a folder dialog opens and every filter is
    written to that folder. If some of the files already exist, one prompt
    lists them and offers Overwrite, Skip these (write only the new files)
    or Cancel (write nothing). Selected filters that share a name get
    ` (2)`, ` (3)`, ... appended so they don't overwrite each other.
- **Import** opens a file dialog in which one or more files can be selected
  (one filter per file, as written by Export; files with several filters,
  such as a copied `msgFilterRules.dat`, work too). For each filter:
  - No local filter with that name: the filter is added.
  - A local filter with that name: the two are merged. Conditions and actions
    that are only in the file are added, local ones are never removed, and
    the local enabled state is kept. A filter that is already identical (the
    enabled state aside) is left alone. For every difference that cannot be
    combined a prompt shows both sides and offers Keep local, Use file or
    Cancel (skips this filter, the local one stays unchanged):
    - a condition with the same field and value but another operator (e.g.
      local "From is a@b.de", file "From contains a@b.de"),
    - "all conditions" against "any condition" (a filter with a single
      condition takes the combination of the other side without asking),
      or "all messages" against conditions,
    - when the filter runs,
    - an action that may appear only once with another value (e.g. Move to
      folder X against Y, or a priority), or actions that exclude each other
      (Move against Delete, Mark read against Mark unread). Copy to folder,
      Tag and Forward may appear several times and are simply added.
  - Move to folder, Copy to folder and Reply (template) actions taken from
    the file always lose their target, so mail can never end up in a folder
    of another account. Thunderbird's own Filter Editor opens for that filter
    with "Choose Folder..." and a note listing the previously configured
    folder or template, so you can pick (or first create) the matching
    folder of this account. OK saves the filter, Cancel skips it.

  Afterwards a summary dialog lists every file with its added, merged,
  already present and skipped filters, including the choices made in the
  prompts. If a filename shows that the file was exported from another
  account than the one shown in the Message Filters dialog, the summary warns
  about it; the filters are imported anyway.

Requires Thunderbird 128 or newer. Tested with Thunderbird 153 ESR (Flatpak).

## Project layout

- `manifest.json`, `background.js` - the MailExtension itself. The
  background script only starts the Experiment API below.
- `experiments/filterTools/` - the privileged Experiment API that injects the
  two buttons into the Message Filters dialog and does the export and import
  with Thunderbird's filter service (`MailServices.filters`).
- `src/filterLogic.mjs` - pure, Thunderbird-independent logic: export
  filenames per filter, splitting filter files into filters, conditions and
  actions, merging an imported filter into a local one, and the texts of the
  import prompts, the Filter Editor note and the summary.
- `test/unit/` - unit tests for `src/filterLogic.mjs` (Node's built-in test
  runner).
- `test/integration/` - end-to-end tests that run the built extension in a
  real, headless Thunderbird with a throw-away profile, remote-controlled
  over Marionette.
- `web-ext-config.mjs` - packaging configuration for `web-ext`.
- `.github/workflows/build.yml`, `scripts/publish-release.sh` - GitHub build
  and release pipeline (see "Releases" below).

## Building

```
npm install
npm run build
```

This creates `dist/message-filter-exporter-<version>.xpi`, with the version
from `manifest.json`.

## Releases (GitHub)

Every push to `main` runs `.github/workflows/build.yml` on GitHub: unit
tests, then `npm run build`. The built `.xpi` is kept as an artifact of that
workflow run. If there is no GitHub Release `v<version>` (version from
`manifest.json`) yet, the workflow creates it, tags the pushed commit and
attaches the `.xpi`. Existing releases are never changed or overwritten, so
every published version stays downloadable from the Releases page.

To publish a new version: raise `"version"` in `manifest.json`, then push to
`main`. Pushes without a version change only build and test.

## Installing

1. In Thunderbird open the Add-ons Manager (Tools > Add-ons and Themes).
2. Gear icon > "Install Add-on From File..." and select
   `dist/message-filter-exporter-<version>.xpi`.
3. Open Tools > Message Filters. "Export..." and "Import..." appear below
   "Move to Bottom".

Installing a newer `.xpi` the same way replaces the old version.

### Note for the Flatpak Thunderbird

The Flatpak sandbox only lets Thunderbird see the single file you pick in a
file dialog. "Load Temporary Add-on..." with this project's `manifest.json`
therefore does not work: Thunderbird can read `manifest.json` but not
`background.js` or `experiments/` next to it. Always pick the built `.xpi`
instead - for "Install Add-on From File..." as well as for "Load Temporary
Add-on..." (Tools > Developer Tools > Debug Add-ons).

Console output of the extension (with `devtools.console.stdout.chrome` set to
`true` in the Config Editor) ends up in the user journal when Thunderbird is
started from the desktop: `journalctl --user -f | grep message-filter`.
Alternatively, open Tools > Developer Tools > Error Console.

## Running the tests

```
npm test                  # unit tests
npm run test:integration  # builds the .xpi, then runs it in a headless Thunderbird
```

The integration tests start their own Thunderbird instance with a temporary
profile and never touch your real profile; they can run while your normal
Thunderbird is open. By default they use the Flatpak
`org.mozilla.thunderbird_esr` and put the temporary profile in
`~/.var/app/org.mozilla.thunderbird_esr/` (the Flatpak cannot see other
directories). Environment variables:

- `THUNDERBIRD_FLATPAK_ID` - a different Flatpak app id.
- `THUNDERBIRD_BIN` - path to a non-Flatpak `thunderbird` binary instead; the
  profile then goes to the system temp directory.
- `KEEP_TEST_PROFILE=1` - keep the temporary profile for inspection.
