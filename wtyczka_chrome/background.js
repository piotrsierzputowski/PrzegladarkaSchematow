// Przekierowuje otwarcia plików *.pdf (okno główne) do viewer.html?file=<adres>
const RULE_ID = 1;
async function setEnabled(on) {
  const viewer = chrome.runtime.getURL('viewer.html');
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: on ? [{
      id: RULE_ID, priority: 1,
      action: { type: 'redirect', redirect: { regexSubstitution: viewer + '?file=\\1' } },
      condition: {
        regexFilter: '^((?:https?|file)://[^?#]*\\.pdf(?:\\?[^#]*)?)(?:#.*)?$',
        isUrlFilterCaseSensitive: false,
        resourceTypes: ['main_frame']
      }
    }] : []
  });
  await chrome.storage.local.set({ enabled: on });
  await chrome.action.setBadgeText({ text: on ? '' : 'OFF' });
  await chrome.action.setBadgeBackgroundColor({ color: '#777' });
  await chrome.action.setTitle({ title: on ? 'Przeglądarka schematów: włączona (kliknij, aby wyłączyć)' : 'Przeglądarka schematów: wyłączona — PDF-y otwiera Chrome (kliknij, aby włączyć)' });
}
async function init() {
  const { enabled } = await chrome.storage.local.get('enabled');
  await setEnabled(enabled !== false);
}
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.action.onClicked.addListener(async () => {
  const { enabled } = await chrome.storage.local.get('enabled');
  await setEnabled(enabled === false);
});
