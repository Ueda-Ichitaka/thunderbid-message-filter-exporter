# Message Filter Exporter for Thunderbird

Thunderbird has no built-in way to move message filters from one profile,
computer or account to another. This add-on adds **Export...** and
**Import...** buttons to the Message Filters dialog (Tools > Message Filters).
They save single filters to files and bring them back, merging them into
existing filters where needed.

Requires Thunderbird 128 or newer. Tested with Thunderbird 153 ESR (Flatpak).

<!-- Screenshot: Message Filters dialog with the Export... and Import...
     buttons below "Move to Bottom" (docs/screenshots/filter-dialog.png) -->

## Features

### Export

- Exports the filters selected in the list (Ctrl/Shift-click for several).
  Export is disabled while nothing is selected.
- Each filter goes into its own file in Thunderbird's native filter format,
  named `<email>_<filter name>_MessageFilters.dat`. Accounts without an email
  address, such as Local Folders, use the account name instead.
- **One filter:** a Save dialog opens with that filename, and the dialog
  itself asks before replacing a file.
- **Several filters:** a folder dialog opens. If some files already exist, one
  prompt lists them and offers **Overwrite**, **Skip these** or **Cancel**.
  Nothing is overwritten without asking.

<!-- Screenshot: overwrite prompt when exporting several filters
     (docs/screenshots/export-overwrite.png) -->

### Import

- One or more files can be selected at once. A file normally holds one
  filter, but files with several filters, such as a copied
  `msgFilterRules.dat`, work too.
- **New filter name:** the filter is added to the account.
- **Existing filter name:** the imported filter is merged into the local one.
  - Conditions and actions that are only in the file are added.
  - Local conditions and actions are never removed, and the local on/off state
    is kept.
  - A filter that is already identical is left alone.
- **Conflicts:** a prompt shows both versions and asks **Keep local**,
  **Use file** or **Cancel**. Cancel skips this filter and leaves the local one
  unchanged. A conflict is:
  - the same field and value with another operator (e.g. "From is a@b.de"
    against "From contains a@b.de");
  - "all conditions" against "any condition", or "all messages" against
    conditions;
  - a different setting for when the filter runs;
  - an action that may appear only once with another value (e.g. Move to
    folder X against Y), or actions that exclude each other (Move against
    Delete, Mark read against Mark unread).

<!-- Screenshot: conflict prompt with Keep local / Use file / Cancel
     (docs/screenshots/import-conflict.png) -->

- **Folders are chosen again:** Move to folder, Copy to folder and Reply
  (template) actions from a file lose their target, so mail never ends up in
  a folder of another account. Thunderbird's own Filter Editor opens with
  "Choose Folder..." and a note showing the previously configured folder.
  You pick the matching folder of this account (or create it first). OK
  saves the filter, Cancel skips it.

<!-- Screenshot: Filter Editor with "Choose Folder..." and the note showing
     the previous folder (docs/screenshots/import-filter-editor.png) -->

- **Summary:** afterwards a dialog lists every file with its added, merged,
  already present and skipped filters, and the choices made. If a filename
  shows that the file comes from another account, the summary warns about
  it; the filters are imported anyway. The status bar of the Message Filters
  dialog shows a one-line count.

<!-- Screenshot: import summary dialog (docs/screenshots/import-summary.png) -->

## Why the add-on needs full access

When you install it, Thunderbird warns that the add-on can "Have full,
unrestricted access to Thunderbird, and your computer".

Thunderbird's add-on APIs have no way to read or change message filters. The
add-on therefore uses an
[Experiment API](https://developer.thunderbird.net/add-ons/mailextensions/experiments),
privileged code that runs inside Thunderbird. Experiments bypass the normal
permission system, so Thunderbird always shows this generic warning for them,
however little they do.

What the add-on actually does:

- reads and changes the filter list of the account shown in the Message
  Filters dialog;
- reads and writes only the files you pick in a file dialog;
- uses temporary files in Thunderbird's temp folder and deletes them again;
- makes no network connections.

The privileged code is in `experiments/filterTools/implementation.js`.

## Installing

1. Get the `.xpi`: download it from the
   [GitHub Releases](../../releases) page, or build it yourself (see below).
2. In Thunderbird open Tools > Add-ons and Themes, click the gear icon and
   choose **Install Add-on From File...**.
3. Select the `.xpi`. A newer `.xpi` replaces an installed older version.

**Flatpak Thunderbird:** always pick the `.xpi`, also for "Load Temporary
Add-on...". The sandbox only lets Thunderbird read the single file you pick,
so loading the project's `manifest.json` cannot work.

## Development

### Requirements

- Node.js 24 or newer, with npm.
- Thunderbird, for the integration tests: by default the Flatpak
  `org.mozilla.thunderbird_esr`.

```
npm ci
```

installs the build and test tools (`web-ext`).

### Project layout

| Path | Content |
|---|---|
| `manifest.json`, `background.js` | The add-on. The background script only starts the Experiment API. |
| `experiments/filterTools/` | The Experiment API: buttons, file dialogs, prompts, Filter Editor, and reading and writing filters. |
| `src/filterLogic.mjs` | Pure logic without Thunderbird: filenames, parsing and merging filters, prompt and report texts. |
| `test/unit/` | Unit tests for `src/filterLogic.mjs` and the release script. |
| `test/integration/` | End-to-end tests in a real, headless Thunderbird. |
| `web-ext-config.mjs` | Packaging configuration. |
| `.github/workflows/build.yml`, `scripts/publish-release.sh` | GitHub build and release pipeline. |

### Building the .xpi

```
npm run build
```

This creates `dist/message-filter-exporter-<version>.xpi`, with the version
taken from `manifest.json`. An existing file of the same version is
overwritten.

### Running the tests

```
npm test                  # unit tests, no Thunderbird needed
npm run test:integration  # builds the .xpi, then tests it in a headless Thunderbird
```

The integration tests start their own Thunderbird with a temporary profile,
install the freshly built `.xpi` and control it over Marionette. They never
touch your real profile and can run while your normal Thunderbird is open.
File dialogs and prompts are replaced by stand-ins with preset answers;
Thunderbird's Filter Editor is the real one.

By default the temporary profile is created in
`~/.var/app/org.mozilla.thunderbird_esr/`, because the Flatpak cannot see
other directories. Environment variables:

- `THUNDERBIRD_FLATPAK_ID` - use another Flatpak app id.
- `THUNDERBIRD_BIN` - path to a non-Flatpak `thunderbird` binary. The
  profile then goes to the system temp directory.
- `KEEP_TEST_PROFILE=1` - keep the temporary profile for inspection.

### Releases

Every push to `main` runs the unit tests and builds the `.xpi` on GitHub.
If no GitHub Release `v<version>` exists yet, the workflow creates one with
the `.xpi` attached. Existing releases are never changed, so every version
stays available. To publish a new version, raise `"version"` in
`manifest.json` and push.
