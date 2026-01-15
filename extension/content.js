// Cathedral Library Extension - Content Script for Kindle Cloud Reader

// This script runs on read.amazon.com pages

console.log('Cathedral Library: Content script loaded on Kindle Cloud Reader');

// Create a floating button for quick capture
function createCaptureButton() {
  const button = document.createElement('div');
  button.id = 'cathedral-capture-btn';
  button.innerHTML = '📚';
  button.title = 'Send to Cathedral Library';
  button.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 50px;
    height: 50px;
    background: #1e5a66;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    cursor: pointer;
    z-index: 999999;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    transition: all 0.2s;
  `;

  button.addEventListener('mouseenter', () => {
    button.style.transform = 'scale(1.1)';
    button.style.background = '#2a7a8a';
  });

  button.addEventListener('mouseleave', () => {
    button.style.transform = 'scale(1)';
    button.style.background = '#1e5a66';
  });

  button.addEventListener('click', handleCapture);

  document.body.appendChild(button);
}

// Extract visible text from Kindle reader
function extractKindleText() {
  // Various selectors that Kindle Cloud Reader uses
  const contentSelectors = [
    '#kindleReader_content',
    '#kr-renderer',
    '.kp-notebook-render-text',
    '[data-cfi]',
    '.kg-full-page-img-fix',
    '#column_0_content_column',
    '.column_content',
    '#kindleReader_container'
  ];

  let bestText = '';
  let bestLength = 0;

  for (const selector of contentSelectors) {
    const elements = document.querySelectorAll(selector);
    for (const el of elements) {
      const text = el.innerText || el.textContent || '';
      if (text.length > bestLength) {
        bestText = text;
        bestLength = text.length;
      }
    }
  }

  // Also try to get selected text if any
  const selection = window.getSelection();
  const selectedText = selection.toString().trim();

  if (selectedText.length > 50) {
    return {
      text: selectedText,
      isSelection: true
    };
  }

  return {
    text: bestText.trim(),
    isSelection: false
  };
}

// Get book title from Kindle UI
function getBookTitle() {
  // Try various title selectors
  const titleSelectors = [
    '.kp-notebook-cover-title',
    '#kr-title-bar-title',
    '.a-text-bold',
    'title'
  ];

  for (const selector of titleSelectors) {
    const el = document.querySelector(selector);
    if (el) {
      let title = el.innerText || el.textContent || '';
      title = title.replace(' - Kindle Cloud Reader', '').trim();
      if (title && title.length > 2 && title.length < 200) {
        return title;
      }
    }
  }

  // Fallback to document title
  return document.title.replace(' - Kindle Cloud Reader', '').trim() || 'Kindle Book';
}

// Handle capture button click
async function handleCapture() {
  const button = document.getElementById('cathedral-capture-btn');
  const originalContent = button.innerHTML;

  try {
    button.innerHTML = '...';
    button.style.pointerEvents = 'none';

    // Get server URL from storage
    const result = await chrome.storage.local.get(['serverUrl']);
    const serverUrl = result.serverUrl;

    if (!serverUrl) {
      alert('Please configure the server URL in the extension popup first.');
      return;
    }

    const { text, isSelection } = extractKindleText();
    const title = getBookTitle();

    if (!text || text.length < 20) {
      alert('Could not extract text from this page. Try selecting specific text first.');
      return;
    }

    const response = await fetch(`${serverUrl}/library/readings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: isSelection ? `${title} (Selection)` : title,
        url: window.location.href,
        text: text.substring(0, 50000),
        source: 'kindle-extension'
      })
    });

    const data = await response.json();

    if (data.success) {
      button.innerHTML = '✓';
      button.style.background = '#4a9';
      setTimeout(() => {
        button.innerHTML = originalContent;
        button.style.background = '#1e5a66';
      }, 2000);
    } else {
      throw new Error(data.error || 'Failed to save');
    }
  } catch (e) {
    console.error('Cathedral Library error:', e);
    button.innerHTML = '✗';
    button.style.background = '#c44';
    alert('Error sending to Library: ' + e.message);
    setTimeout(() => {
      button.innerHTML = originalContent;
      button.style.background = '#1e5a66';
    }, 2000);
  } finally {
    button.style.pointerEvents = 'auto';
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'extractText') {
    const { text, isSelection } = extractKindleText();
    const title = getBookTitle();
    sendResponse({
      text,
      title,
      isSelection,
      url: window.location.href
    });
  }
  return true;
});

// Wait for page to fully load before adding button
if (document.readyState === 'complete') {
  createCaptureButton();
} else {
  window.addEventListener('load', createCaptureButton);
}

// Also try after a delay in case Kindle loads dynamically
setTimeout(createCaptureButton, 3000);
