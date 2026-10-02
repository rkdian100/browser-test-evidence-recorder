# Record and run a Playwright workflow

## Record
1. Reload the unpacked extension, refresh the target webpages, and choose **New Session**.
2. Set a Test Case ID and leave recording enabled.
3. Perform your workflow normally, including login, typing, and selecting options. Screenshot mode can be Automatic or Manual; the action log records in both modes.
4. Click **Playwright**. The current action history exports to `Downloads/Browser Test Evidence Recorder/playwright-tests/`.

Start at the login page if the test should log in. If recording begins inside an already authenticated app, supply an authentication state file when replaying.

## Run the downloaded test
In a separate test directory with Node.js and npm installed:

```powershell
npm init -y
npm install --save-dev @playwright/test
npx playwright install chromium
```

Copy the exported `.spec.js` into that directory. Open it and check the `requiredEnv(...)` calls near the beginning. They list the values you must supply. For example, if it requests `BTE_PASSWORD_3`:

```powershell
$env:BTE_PASSWORD_3 = 'your test account password'
npx playwright test your-exported-file.spec.js --headed
```

The environment variable names include the recorded step number and may differ for each export. Use test account credentials. Recognized password, token, secret, one-time-code, and payment credential fields omit their typed values from the action log; ordinary fields retain their values. Screenshots still show what was visible on the page.

For an upload, provide a JSON array of paths to files available on the replay machine:

```powershell
$env:BTE_UPLOAD_12 = '["C:/test-data/invoice.pdf"]'
```

For an existing authenticated session, optionally supply a Playwright storage-state file:

```powershell
$env:BTE_STORAGE_STATE = 'C:/test-data/auth.json'
```

The recorder does not export browser cookies or create that state file. See the official [Playwright authentication guide](https://playwright.dev/docs/auth).

## Replay behavior
- Locators prefer unique test attributes, labels, and roles. Stable attributes and a structural CSS path provide fallbacks at recording time. Structural locators are marked for review.
- The script uses locator actions with automatic waiting, not fixed sleeps or `networkidle`.
- Typed changes are consolidated into `fill()` actions. Edits flush before clicks, Enter submission, pause, and export.
- Password values are supplied through environment variables at runtime.
- Native single/multiple selects use `selectOption()`. Checkboxes/radios use `setChecked()`. Contenteditable fields use `fill()`.
- Clicks, double-clicks, and selected keyboard actions are retained. Clicks on child icons resolve to their interactive ancestor.
- Each recorded browser tab has its own Playwright page. Popup waits start before the opening action. Independent tabs use `context.newPage()`.
- Navigation caused by an action is verified with `toHaveURL()`, so the test does not bypass a failed login by navigating directly to the destination.
- Explicit address-bar navigation, reload, and known back/forward history entries use the corresponding browser operations.
- Frame actions resolve through their recorded parent-frame URL chain. Open shadow DOM is supported by Playwright locators.
- Final screenshots are attached to the test results. Add business-specific assertions such as checking a saved record or success message where your application requires them.

## Boundaries
This records browser workflows; it cannot guarantee replay across every application or a changed UI.

- MFA/CAPTCHA, native desktop applications, browser chrome, closed shadow roots, drag-and-drop, hover-only menus, and JavaScript dialog responses need application-specific steps.
- Keyboard-driven widgets that require individual character events may need `pressSequentially()` instead of `fill()`.
- Duplicate sibling frames with the same URL are ambiguous and fail explicitly. Replace their URL lookup with a stable `frameLocator()` when necessary.
- Multiple popups from one action fail export with an explanation. Unmatched popup openings fail explicitly during replay.
- Dynamically generated OAuth redirect URLs, changing query parameters, and environment-specific hosts may need URL assertions adjusted.
- A recording that starts halfway through a workflow may be missing prerequisite state. Old screenshot histories do not contain the actions needed for replay.
- The recorder retains at most 5000 actions in the current session and rejects incomplete exports rather than silently dropping early steps.

## Automated verification
`node tests/playwright-e2e.cjs` starts a local sample web app, records real Chrome/Chromium interactions using the content recorder, exports the test, and runs it in a fresh browser context with Playwright Test. It adds fixture assertions to verify final values and authentication.

The fixture covers Enter and button-based login, full-page redirects, SPA navigation, quoted/multiline text, native selects, checkboxes/radios, contenteditable, upload, duplicate button labels, an iframe, open shadow DOM, popup and independent tabs, double-click, reload, back, and forward.

The browser harness provides the extension messaging/storage bridge. Separate service-worker tests check message handling, persistence across restart, session boundaries, secret omission, recording modes, and action retention. This does not install the extension into your existing browser profile or test your private web apps.
