// Cathedral Library Extension - Popup Script

const serverUrlInput = document.getElementById('serverUrl');
const statusEl = document.getElementById('status');
const messageBox = document.getElementById('messageBox');
const captureSelectedBtn = document.getElementById('captureSelected');
const capturePageBtn = document.getElementById('capturePage');
const kindleSection = document.getElementById('kindleSection');
const kindleTitle = document.getElementById('kindleTitle');
const kindleMeta = document.getElementById('kindleMeta');

// Load saved settings
chrome.storage.local.get(['serverUrl'], (result) => {
  if (result.serverUrl) {
    serverUrlInput.value = result.serverUrl;
    checkConnection();
  }
});

// Save settings
document.getElementById('saveSettings').addEventListener('click', () => {
  const url = serverUrlInput.value.trim();
  if (!url) {
    showMessage('Please enter a server URL', 'error');
    return;
  }

  chrome.storage.local.set({ serverUrl: url }, () => {
    showMessage('Settings saved!', 'success');
    checkConnection();
  });
});

// Check connection to server
async function checkConnection() {
  const url = serverUrlInput.value.trim();
  if (!url) {
    setStatus(false);
    return;
  }

  try {
    const response = await fetch(`${url}/library/readings`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.ok) {
      setStatus(true);
      enableButtons();
    } else {
      setStatus(false);
    }
  } catch (e) {
    setStatus(false);
  }
}

function setStatus(connected) {
  if (connected) {
    statusEl.textContent = 'Connected';
    statusEl.className = 'status connected';
  } else {
    statusEl.textContent = 'Not Connected';
    statusEl.className = 'status disconnected';
  }
}

function enableButtons() {
  captureSelectedBtn.disabled = false;
  capturePageBtn.disabled = false;
}

function showMessage(text, type = 'success') {
  messageBox.innerHTML = `<div class="message ${type}">${text}</div>`;
  setTimeout(() => {
    messageBox.innerHTML = '';
  }, 3000);
}

// Check if we're on a Kindle page
chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
  const tab = tabs[0];
  if (tab.url && tab.url.includes('read.amazon.com')) {
    kindleSection.style.display = 'block';
    kindleTitle.textContent = 'Kindle Cloud Reader detected';
    kindleMeta.textContent = 'You can capture text from your book';
  }
});

// Capture selected text
captureSelectedBtn.addEventListener('click', async () => {
  const url = serverUrlInput.value.trim();
  if (!url) {
    showMessage('Please configure server URL first', 'error');
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Execute script to get selected text
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const selection = window.getSelection();
        return {
          text: selection.toString().trim(),
          title: document.title,
          url: window.location.href
        };
      }
    });

    const data = results[0].result;

    if (!data.text) {
      showMessage('No text selected. Please select some text first.', 'error');
      return;
    }

    captureSelectedBtn.disabled = true;
    captureSelectedBtn.textContent = 'Sending...';

    const response = await fetch(`${url}/library/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: data.title || 'Captured Selection',
        url: data.url,
        text: data.text,
        source: 'browser-extension'
      })
    });

    const result = await response.json();

    if (result.success) {
      showMessage('Text sent to Library!', 'success');
    } else {
      showMessage('Error: ' + (result.error || 'Failed to send'), 'error');
    }
  } catch (e) {
    showMessage('Error: ' + e.message, 'error');
  } finally {
    captureSelectedBtn.disabled = false;
    captureSelectedBtn.textContent = 'Send Selected Text';
  }
});

// Capture visible page
capturePageBtn.addEventListener('click', async () => {
  const url = serverUrlInput.value.trim();
  if (!url) {
    showMessage('Please configure server URL first', 'error');
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    // Execute script to get page content
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        // For Kindle, try to get the book content
        const isKindle = window.location.hostname.includes('read.amazon.com');

        if (isKindle) {
          // Try various Kindle content selectors
          const contentSelectors = [
            '#kindleReader_content',
            '.kp-notebook-render-text',
            '#kr-renderer',
            '[data-cfi]',
            '.kg-full-page-img-fix',
            '#column_0_content_column',
            '.column_content'
          ];

          for (const selector of contentSelectors) {
            const el = document.querySelector(selector);
            if (el && el.innerText && el.innerText.trim().length > 50) {
              return {
                text: el.innerText.trim(),
                title: document.title.replace(' - Kindle Cloud Reader', ''),
                url: window.location.href,
                isKindle: true
              };
            }
          }

          // Fallback: get all text from the visible area
          const visibleText = document.body.innerText;
          return {
            text: visibleText.substring(0, 50000),
            title: document.title.replace(' - Kindle Cloud Reader', ''),
            url: window.location.href,
            isKindle: true
          };
        }

        // For regular pages
        // Try to get main content
        const mainContent = document.querySelector('main, article, [role="main"], .content, #content');
        const text = mainContent ? mainContent.innerText : document.body.innerText;

        return {
          text: text.substring(0, 50000),
          title: document.title,
          url: window.location.href,
          isKindle: false
        };
      }
    });

    const data = results[0].result;

    if (!data.text || data.text.length < 10) {
      showMessage('No content found on this page', 'error');
      return;
    }

    capturePageBtn.disabled = true;
    capturePageBtn.textContent = 'Sending...';

    const response = await fetch(`${url}/library/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: data.title || 'Captured Page',
        url: data.url,
        text: data.text,
        source: data.isKindle ? 'kindle-extension' : 'browser-extension'
      })
    });

    const result = await response.json();

    if (result.success) {
      showMessage('Page sent to Library!', 'success');
    } else {
      showMessage('Error: ' + (result.error || 'Failed to send'), 'error');
    }
  } catch (e) {
    showMessage('Error: ' + e.message, 'error');
  } finally {
    capturePageBtn.disabled = false;
    capturePageBtn.textContent = 'Send Visible Page';
  }
});

// Open Library
document.getElementById('openLibrary').addEventListener('click', (e) => {
  e.preventDefault();
  const url = serverUrlInput.value.trim();
  if (url) {
    chrome.tabs.create({ url: `${url}/library` });
  } else {
    showMessage('Please configure server URL first', 'error');
  }
});
