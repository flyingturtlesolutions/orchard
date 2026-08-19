# Install Orchard on your computer

Takes about 5 minutes. If anything looks wrong at any step, **stop and message [SETUP CONTACT]** — don't retry.

## What your setup contact gives you
- The **enroll script** they sent you (`enroll.ps1` on Windows, `enroll.sh` on Mac).
- Chrome, Git, and Node are already installed on your computer (your contact set this up).

No login is needed to download the app.

---

## Step 1 — Run the one setup command

**Windows:** save the `enroll.ps1` file to your Desktop, then open **PowerShell** (Windows key → type `PowerShell` → Enter) and paste this in exactly:
```
powershell -ExecutionPolicy Bypass -File "$HOME\Desktop\enroll.ps1" -RepoUrl https://github.com/flyingturtlesolutions/orchard.git
```

**Mac:** save `enroll.sh`, open **Terminal**, and paste:
```
bash ~/Desktop/enroll.sh https://github.com/flyingturtlesolutions/orchard.git
```

When it finishes you'll see **green** text with your next two steps and a folder path — keep that window open.

## Step 2 — Add it to Chrome (the script tells you the exact folder)

1. Open Chrome. In the address bar type `chrome://extensions` and press Enter.
2. Turn **ON** "Developer mode" (toggle, top-right).
3. Click **Load unpacked** and choose the folder the green text showed you.
4. **"Orchard"** now appears in your list.

## Step 3 — Open it and turn on logging

1. Click the **puzzle-piece** icon (top-right of Chrome) and **pin** Orchard.
2. Click the Orchard icon to open its **side panel**.
3. In the panel's settings, turn on **cloud logs** and sign in when asked.

---

## You're done

Orchard keeps itself up to date. When a new version is ready, a small **reload** button lights up in the panel — click it to apply. Otherwise it updates quietly in the background. You never reinstall.

**Something wrong?** (an error, no green text, the extension won't load) — message **[SETUP CONTACT]** and include a photo of the screen. Don't keep clicking.
