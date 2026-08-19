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
- [ ] **A privacy policy URL** — inherit Deako's (see "Privacy policy" below). Deako is the controller, but
  Deako's existing policy at <https://www.deako.com/legal/> covers the smart-lighting website/app/hardware and
  does **not** mention the extension, AI, or page-content processing — which the store requires the linked
  policy to disclose. So host the short Orchard section below under Deako and use *that* URL.
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

## Privacy policy — inheriting Deako's (with an Orchard section)

Deako is the data controller, so the policy inherits from Deako. But Deako's current policy
(<https://www.deako.com/legal/>) describes only the smart-lighting website, mobile app, and hardware — it names
no browser extension, no AI/LLM, and no reading of page content. The store checks that the linked policy covers
the extension's actual data handling, so add the section below to Deako's `/legal` page (or host it as a
companion page, e.g. `deako.com/legal/orchard`) and use that URL in the submission. Every line is grounded in
what the code does (page content → Anthropic; optional cloud → Deako's AWS backend; logs scrubbed at source).

> **Orchard browser extension**
>
> The Orchard browser extension is provided by Deako. This section supplements Deako's Privacy Policy and
> describes how the extension handles data.
>
> - **What it does with page content.** Orchard is an assistant that helps you operate the websites you work
>   in. When you engage it on a page, it reads that page's content and structure so it can carry out the request
>   you make. It reads and transmits page content only to fulfil a request you initiate.
> - **Where your data goes.** To produce a response, Orchard sends your request and the relevant page content to
>   the Anthropic API (Anthropic PBC), the AI service that powers the assistant. If you enable the optional cloud
>   features (sync and diagnostic logging), the same data may be sent to and stored in Deako's cloud service on
>   Amazon Web Services. Diagnostic logs are scrubbed of identifying values (emails, phone numbers, record IDs)
>   on your device before they are sent.
> - **Stored locally.** Your saved site knowledge, settings, and history are kept locally in your browser.
> - **Sign-in.** The optional cloud features use a Deako/Orchard account; if you do not enable them, no account
>   or sign-in is required and no data leaves your machine except calls to the Anthropic API to answer you.
> - **What we don't do.** We do not sell your data, do not use it for advertising, and do not use it for
>   creditworthiness or lending decisions.
> - **Retention.** Deako's general retention terms in the Privacy Policy apply.
>
> Data controller: Deako, Inc. — see <https://www.deako.com/legal/>. Privacy contact: [Deako privacy contact].

Fill in the one bracket (`[Deako privacy contact]`). This is a factual disclosure I derived from the code; have
Deako's owner review it before it's published, since it's a legal document.

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
