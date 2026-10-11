// About me: web-ext configuration for packaging the extension. `npm run build`
// zips the extension files into dist/message-filter-exporter-<version>.xpi
// (version from manifest.json) and leaves out everything that is only needed
// for development (tests, npm files).

export default {
  artifactsDir: "dist",
  ignoreFiles: [
    "dist",
    "test",
    "package.json",
    "package-lock.json",
    "web-ext-config.mjs",
    "README.md",
  ],
  build: {
    filename: "message-filter-exporter-{version}.xpi",
    overwriteDest: true,
  },
};
