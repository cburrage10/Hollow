# Safari Extension Setup Guide

Safari Web Extensions use the same WebExtension API as Chrome, but require Xcode to package and sign the extension.

## Requirements

- macOS with Xcode installed
- Apple Developer Account (free tier works for personal use)

## Converting Chrome Extension to Safari

### Step 1: Open Terminal on macOS

Run the Safari Web Extension converter:

```bash
xcrun safari-web-extension-converter /path/to/extension --project-location ~/Desktop/CathedralLibrarySafari
```

Replace `/path/to/extension` with the path to this extension folder.

### Step 2: Open in Xcode

The converter creates an Xcode project. Open it:

```bash
open ~/Desktop/CathedralLibrarySafari/Cathedral\ Library.xcodeproj
```

### Step 3: Configure Signing

1. Select the project in the sidebar
2. Go to "Signing & Capabilities"
3. Select your Team (Apple ID)
4. Let Xcode manage signing automatically

### Step 4: Build and Run

1. Select your target device (Mac or connected iPhone/iPad)
2. Click the Play button to build and install

### Step 5: Enable in Safari

**On macOS:**
1. Open Safari > Preferences > Extensions
2. Check "Cathedral Library" to enable

**On iOS/iPadOS:**
1. Open Settings > Safari > Extensions
2. Enable "Cathedral Library"
3. Set permissions to "Allow"

## iOS/iPadOS Notes

- The extension popup appears in the Safari toolbar (tap the puzzle icon)
- Content scripts work on iPad but may have limitations on iPhone
- Screen capture is not available in Safari mobile

## Troubleshooting

**"Extension not loading"**
- Ensure you've enabled the extension in Safari settings
- Check that the website is in the permissions list

**"Cannot connect to server"**
- Verify the server URL is correct
- Ensure HTTPS is used (Safari blocks HTTP)

**"Content script not working"**
- Some sites block content scripts
- Try the popup's "Send Visible Page" button instead

## Alternative: Safari Shortcut

For quick capture without the full extension on iOS:

1. Open Shortcuts app
2. Create new shortcut
3. Add "Get Text from Input"
4. Add "Get Contents of URL" action:
   - URL: `https://your-server.railway.app/library/readings`
   - Method: POST
   - Headers: Content-Type: application/json
   - Body: JSON with title, text, url, source fields

5. Save and add to Share Sheet

This creates a share option to send selected text to your Library.
