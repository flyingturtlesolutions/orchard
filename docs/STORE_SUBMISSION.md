# Chrome Web Store — unlisted pre-release submission

A practical checklist for putting Orchard on the store as **unlisted** (or trusted-testers) so testers get native
auto-update on the real release pipeline. The custom `tools/updater/` fleet updater is only for off-store testing;
once this is live, the store handles updates and the updater is retired.

## 0. Before you submit — you must supply these

The packaging + permissions are solved (`tools/pack-store.cjs`). These are the human/business items no script can do:

- [ ] **A Chrome Web Store developer account** — one-time $5 registration at
  <https://chrome.google.com/webstore/devconsole> with a Google account.
- [ ] **Load-test the package once.** `node tools/pack-store.cjs`, then load `dist/orchard-store-v<version>/`
  as an unpacked extension and confirm it runs. This is the one thing a static check can't prove.
- [x] **A privacy policy URL** — **done: hosted in this repo at [`docs/PRIVACY.md`](PRIVACY.md).** Because the
  repo is public, its GitHub URL is a valid store privacy-policy URL, so Deako's site needs no edit. Use:
  `https://github.com/flyingturtlesolutions/orchard/blob/main/docs/PRIVACY.md` (or enable GitHub Pages for a
  cleaner `…github.io/orchard/…` URL). It names Deako as controller and links to Deako's general policy. Fill
  the one `[privacy contact]` bracket, and have Deako's owner glance at it (it's a legal doc).
- [ ] **Store listing assets:** a 128×128 icon (you have `assets/icon128.png`), at least one screenshot
  (1280×800 or 640×400), a short summary (≤132 chars), and a description.
- [ ] **Decide visibility:** *Unlisted* (anyone with the link can install) or *Private → trusted testers*
  (only listed Google accounts). Either way it goes through review.

## 1. Package

```
node tools/pack-store.cjs        # → dist/orchard-store-v<version>.zip
```
Upload that **zip** (not the folder). It already has `key`, `debugger`, `nativeMessaging`, and `activeTab` stripped.
Each upload's version must be higher than the last — the manifest version bumps on its own, so that's automatic.

## 2. Create the item + upload

Dev console → **Add new item** → drag the zip in. It reads the manifest and pre-fills the technical fields.

## 3. Store listing tab

Name **Orchard**, the summary + description below, category **Productivity**, language, the 128px icon, and ≥1
screenshot. (For unlisted, keep copy minimal — it isn't public-searchable.)

## 4. Privacy practices tab — the justifications (paste-ready)

**Single purpose**
> Orchard is an AI assistant in the Chrome side panel that learns to operate the websites you work in and carries
> out tasks you ask for on those sites.

**Permission justifications** (one per requested permission):

| Permission | Justification |
|---|---|
| `host_permissions` `<all_urls>` | Orchard acts on whatever website you direct it to — reading the current page and performing the clicks and form entries you request. Because you may work in any site, it needs access to all sites, and only reads or acts on a page when you ask it to. |
| `tabs` | To open, focus, and identify the browser tab you're working in so the assistant acts on the right page. |
| `scripting` | To read the current page and perform the actions you request (clicking, typing, navigating) on it. |
| `cookies` | To detect whether you're signed in to a target site via cookie-change events, so the assistant knows the site is reachable. It does not read or transmit cookie values. |
| `webNavigation` | To detect when an action caused the page to navigate and to locate the correct frame on multi-frame pages. |
| `clipboardRead` | To capture a value from the clipboard, only when you use the "copy this" capture action. |
| `offscreen` | To read the clipboard for that capture action, since a service worker cannot access the clipboard directly. |
| `identity` | To sign you in to the optional Orchard cloud account, only if you enable cloud sync or logging. |
| `alarms` | To run background checks you've scheduled without keeping the service worker awake. |
| `notifications` | To alert you when a task you scheduled needs your attention. |
| `idle` | To pause scheduled checks while your computer is idle and resume them when you return. |
| `sidePanel` | The extension's entire interface is a Chrome side panel. |
| `storage` / `unlimitedStorage` | To save your site knowledge, settings, and history locally; this can exceed the default storage limit. |
| host `api.anthropic.com` | To send your requests to the Anthropic AI model that powers the assistant. |
| hosts `*.execute-api…`, `*.amazoncognito.com`, `*.s3…amazonaws.com` | The optional Orchard cloud backend (sign-in, sync, log storage), used only if you enable cloud features. |

**Are you using remote code?**
> No. The extension executes only the JavaScript included in the package; it does not download or evaluate remote code.

**Data use** — declare honestly, because it's true:
- **Website content** — Orchard reads the content of pages you direct it to and sends your request plus relevant
  page content to the Anthropic API to produce a response.
- **User activity** — the actions you ask it to perform.
- If cloud features are enabled, the same data may go to the Orchard cloud backend.
- Check the three certifications: not sold to third parties · not used for unrelated purposes · not used for
  creditworthiness/lending. Provide the privacy policy URL.

## Privacy policy — hosted in this repo

The full policy is [`docs/PRIVACY.md`](PRIVACY.md), served from the public repo — no Deako-site edit needed. It
names Deako as the data controller and links to Deako's general policy (<https://www.deako.com/legal/>) for the
company-wide terms, while covering the extension-specific data flow the store requires: page content → Anthropic;
optional cloud → Deako's AWS backend; diagnostic logs scrubbed on-device. Every line is grounded in what the code
does.

**Store privacy-policy URL:** `https://github.com/flyingturtlesolutions/orchard/blob/main/docs/PRIVACY.md`
(or, for a cleaner page, enable GitHub Pages on `docs/` and use the resulting `…github.io/orchard/…` URL).

Two small to-dos before submitting: fill the `[privacy contact]` bracket in `PRIVACY.md`, and have Deako's owner
glance at it (it's a legal document, derived from the code but worth a human sign-off).

## 5. Distribution / visibility

Set **Unlisted**, or **Private** and add tester emails under *trusted testers*. Save.

## 6. Submit for review

Submit. First review of a broad-permission extension is realistically a few days (updates are usually faster).
The `<all_urls>` scope is the remaining scrutiny driver; the `<all_urls>` justification above is written to answer it.

## 7. Iterate

Fix → `node tools/pack-store.cjs` → **Package** → upload the new zip → submit. Testers auto-update once it clears
review. No re-enrollment, no reload button — the store handles it.

---

## Before a PUBLIC (not unlisted) release — two open items

1. **Swap the dev cloud endpoint.** `host_permissions` still lists `https://api.dev.orchard.example.com/*` — a
   dev/placeholder. The cloud features won't work in production until this is the real prod URL (also a functional
   bug, not just a review note).
2. **Reconsider `<all_urls>`.** It's justifiable, but if the product only needs to act on sites the user has
   engaged, scoping host access (or leaning on `activeTab`) reviews faster and reassures users. A design call.
