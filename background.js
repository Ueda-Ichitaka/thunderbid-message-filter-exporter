// About me: Background script of the message filter exporter. Its only job is
// to start the privileged filterTools Experiment API, which then adds the
// Export/Import buttons to every Message Filters dialog that opens.

browser.filterTools.initialize().catch((error) => {
  console.error("[message-filter-exporter] filterTools.initialize() failed", error);
});
