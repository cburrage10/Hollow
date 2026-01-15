// Cathedral Library Extension - Background Service Worker

// Handle installation
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('Cathedral Library extension installed');
  } else if (details.reason === 'update') {
    console.log('Cathedral Library extension updated');
  }
});

// Handle messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'sendToLibrary') {
    handleSendToLibrary(message.data)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }
});

// Send text to library server
async function handleSendToLibrary(data) {
  const result = await chrome.storage.local.get(['serverUrl']);
  const serverUrl = result.serverUrl;

  if (!serverUrl) {
    throw new Error('Server URL not configured');
  }

  const response = await fetch(`${serverUrl}/library/readings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });

  return await response.json();
}

// Context menu for quick capture
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'sendToLibrary',
    title: 'Send to Cathedral Library',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'sendToLibrary' && info.selectionText) {
    try {
      const result = await handleSendToLibrary({
        title: tab.title || 'Selected Text',
        url: tab.url,
        text: info.selectionText,
        source: 'context-menu'
      });

      if (result.success) {
        // Show notification
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: 'Cathedral Library',
          message: 'Text sent to Library!'
        });
      }
    } catch (e) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'Cathedral Library',
        message: 'Error: ' + e.message
      });
    }
  }
});
