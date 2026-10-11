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
- **Import** reads such a file and appends only the filters that are not
  already present on the shown account (matched by name, type, conditions,
  and actions - the enabled/disabled state is ignored). Filters that are
  already present are left untouched and not duplicated.

The result of an export or import is shown in the status bar at the bottom
of the Message Filters dialog. Errors (e.g. a file that is not a filter file)
are shown in a popup.

Requires Thunderbird 128 or newer. Tested with Thunderbird 153 ESR (Flatpak).

## Project layout

- `manifest.json`, `background.js` - the MailExtension itself. The
  background script only starts the Experiment API below.
- `experiments/filterTools/` - the privileged Experiment API that injects the
  two buttons into the Message Filters dialog and does the export and import
  with Thunderbird's filter service (`MailServices.filters`).
- `src/filterLogic.mjs` - pure, Thunderbird-independent logic: export
  filenames per filter, splitting filter files into one text block per
  filter, and picking the filters that are new on import.
- `test/unit/` - unit tests for `src/filterLogic.mjs` (Node's built-in test
  runner).
- `test/integration/` - end-to-end tests that run the built extension in a
  real, headless Thunderbird with a throw-away profile, remote-controlled
  over Marionette.
- `web-ext-config.mjs` - packaging configuration for `web-ext`.

## Building

```
npm install
npm run build
```

This creates `dist/message-filter-exporter-<version>.xpi`, with the version
from `manifest.json`.

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
