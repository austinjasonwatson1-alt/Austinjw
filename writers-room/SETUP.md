# Setup: get Writer's Room onto your phone

About 15 minutes, once. You'll create three free or cheap accounts, paste four values into Vercel, and add the app to your home screen. No keys ever go in the code or the repo.

## 1. Database: Supabase (free)

1. Go to **supabase.com**, sign up, and click **New project**.
2. Name it `writers-room`, set a strong database password (save it in your password manager), and pick the region closest to you.
3. When the project is ready, click **Connect** in the top bar, choose **Transaction pooler**, and copy the connection string (it uses port `6543`).
4. Replace `[YOUR-PASSWORD]` in it with your database password. This is your **`DATABASE_URL`**.

The app creates its own tables the first time it runs.

## 2. Speech-to-text: Deepgram

1. Go to **console.deepgram.com**, sign up, and open **API Keys**.
2. Create a key. This is your **`DEEPGRAM_API_KEY`**.

Cost: well under $1 a month at a few drives a week.

## 3. Transcript cleanup: Anthropic

1. Go to **console.anthropic.com**, open **API Keys**, and create a key. This is your **`ANTHROPIC_API_KEY`**.

Cost: a few cents a month at this volume.

## 4. Hosting: Vercel (free)

1. Go to **vercel.com** and sign up with your GitHub account.
2. Click **Add New → Project** and import the `Austinjw` repository.
3. Set **Root Directory** to `writers-room`.
4. Under **Environment Variables**, add:

   | Name | Value |
   | --- | --- |
   | `APP_PASSPHRASE` | A passphrase only you know (a few random words works well) |
   | `DATABASE_URL` | From step 1 |
   | `DEEPGRAM_API_KEY` | From step 2 |
   | `ANTHROPIC_API_KEY` | From step 3 |

5. Click **Deploy**. You get a private web address like `writers-room-xyz.vercel.app`.

Leave Vercel Analytics and Speed Insights off (they're off by default). The project rules say no analytics.

**Which code gets deployed:** Vercel publishes the repository's `main` branch. Milestone 1 lives on the branch `claude/inspiring-wright-obyaoa` until it's merged into `main` (I can open a pull request whenever you like). To try it before merging, set that branch as the production branch in Vercel under **Settings → Environments → Production → Branch Tracking**.

## 5. On your iPhone

1. Open your Vercel address in **Safari** and enter your passphrase. The phone stays signed in for a year.
2. Tap **Share → Add to Home Screen**. You now have a Writer's Room icon that opens full-screen.
3. Open it from the icon, tap the red button and allow the microphone.

## 6. Hands-free start with Siri (optional, about 2 minutes)

This lets you say **"Hey Siri, capture idea"** and have Writer's Room open already recording.

1. Open the **Shortcuts** app and tap **+**.
2. Tap **Add Action**, search for **Open URLs** and choose it.
3. For the URL, type your Vercel address followed by `/?start=1`, for example `https://writers-room-xyz.vercel.app/?start=1`.
4. Tap the name at the top, rename the shortcut to **Capture idea** and tap **Done**. Siri uses the shortcut's name as the phrase.

Good to know:
- The shortcut opens in **Safari**, not the home-screen icon. iPhone keeps their sign-ins separate, so enter your passphrase once in Safari too.
- Your phone has to be unlocked. In a mount with Face ID that's usually automatic.
- If the phone still wants a tap before recording starts, the big button will be waiting. Tell me if that happens.
- You'll hear a soft rising tone when recording starts and a falling tone when it stops, so you don't need to look.

## Your first test drive

- [ ] Put the phone in a mount with Writer's Room open **before you start driving**.
- [ ] Start with "Hey Siri, capture idea" (or tap the button) and listen for the start tone. Then talk. Try "scene note…", then "new note", then "character note…", then an idea with no label.
- [ ] Check the screen stays on while recording. (iPhone Safari stops web-app recordings if the screen locks or you switch apps. This is the main thing to find out.)
- [ ] After parking, tap stop and see whether the notes appear and are split correctly.
- [ ] In the Inbox, try swiping a note right to keep it, editing one, and opening **⋯** to compare it with exactly what you said.
- [ ] Note anything that felt slow, confusing or wrong, and tell me.

## If something goes wrong

- **"Couldn't transcribe" in the Inbox:** the recording is saved. Check the two API keys in Vercel, then tap **Try again**.
- **"Set APP_PASSPHRASE…" page:** the passphrase variable is missing in Vercel. Add it and redeploy.
- **Recorded with no signal:** the recording is kept on the phone and uploads the next time the app is open with a connection.
