# Exam Grader - Google Drive / Sheets server

This optional Apps Script receives graded PDFs and gradebook rows from Exam Grader and stores them in your own Google Drive.

What it creates:
- Folder `Exam Grader/<exam title> (<version>)` with one PDF per student (re-saving replaces the earlier file of the same name).
- Spreadsheet `Exam Grader - Gradebook` (inside the `Exam Grader` folder) with one tab per exam. Rows are updated by Student ID.

## Deploy

1. Go to https://script.google.com and click **New project** (or, from a Google Sheet, **Extensions > Apps Script**). Name it "Exam Grader server".
2. Replace the contents of `Code.gs` with the file `server/Code.gs` from this folder. Save.
3. **Project Settings** (gear icon) > **Script properties** > **Add script property**:
   - `TOKEN`: a long random secret (the same text goes into the app).
   - `GEMINI_KEY`: only if you want AI grading suggestions. Create a free key at https://aistudio.google.com (Get API key) and paste it here. Never put this key in the web app.
   Click **Save script properties**.
4. Click **Deploy > New deployment**. Click the gear next to "Select type" and choose **Web app**.
5. Description: "Exam Grader". **Execute as: Me**. **Who has access: Anyone**. Click **Deploy**.
6. Click **Authorize access** and allow access for your account (Drive, Sheets, and "Connect to an external service", which the AI suggestions use to reach Google's Gemini API).
7. Copy the **Web app URL** (ends in `/exec`).
8. In Exam Grader open **Settings > Google Drive / Sheets**, paste the URL and the same token, then click **Test connection**.
9. On the **Results** screen use **Save to Google Drive**.
10. Optional AI suggestions: **Settings > AI suggestions (Google Gemini)** > tick the box > **Test connection and load models**. Leave the model on Automatic unless you want a specific one.

After editing `Code.gs` later, use **Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy** so the same URL serves the new code. If a new version needs a new permission (for example the AI suggestions after upgrading), run any function once from the editor or re-open the deployment to approve it.

## AI suggestions (optional)

- The server action `aiModels` lists the Gemini models your key may use; `aiGrade` sends one answer-box image (plus up to 4 teacher-graded example images of the same question, the question, answer key, rubric and preset comments) to `models/<model>:generateContent` and returns points, a rubric breakdown, a short comment, a legibility flag, a confidence level and suggested pen marks.
- Nothing is saved as a grade until the teacher accepts it in the app.
- Free tier: Google limits requests per minute and per day for each model. The app paces itself (12 per minute by default) and stops at a daily limit you set (480 by default). If Google answers "rate limited", the app pauses and resumes.
- Privacy: on Google's free tier, submitted content may be used by Google to improve its products and may be read by human reviewers. Only the answer-box crop is sent (no name, no ID, no cover page). Check your school's privacy rules before using it.

## Notes

- "Anyone" access is needed so the browser app can reach the script without a Google sign-in; requests without the correct token are refused.
- Requests are sent as `text/plain` JSON, which avoids a CORS preflight that Apps Script does not answer.
- Each PDF is sent as one request. Apps Script limits a request to about 50 MB, far above a normal exam packet.
