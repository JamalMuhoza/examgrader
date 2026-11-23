# Exam Grader - Google Drive / Sheets server

This optional Apps Script receives graded PDFs and gradebook rows from Exam Grader and stores them in your own Google Drive.

What it creates:
- Folder `Exam Grader/<exam title> (<version>)` with one PDF per student (re-saving replaces the earlier file of the same name).
- Spreadsheet `Exam Grader - Gradebook` (inside the `Exam Grader` folder) with one tab per exam. Rows are updated by Student ID.

## Deploy

1. Go to https://script.google.com and click **New project**. Name it "Exam Grader server".
2. Replace the contents of `Code.gs` with the file `server/Code.gs` from this folder. Save.
3. **Project Settings** (gear icon) > **Script properties** > **Add script property**: name `TOKEN`, value a long random secret. Save.
4. Click **Deploy > New deployment**. Click the gear next to "Select type" and choose **Web app**.
5. Description: "Exam Grader". **Execute as: Me**. **Who has access: Anyone**. Click **Deploy**.
6. Click **Authorize access** and allow Drive and Sheets access for your account.
7. Copy the **Web app URL** (ends in `/exec`).
8. In Exam Grader open **Settings > Google Drive / Sheets**, paste the URL and the same token, then click **Test connection**.
9. On the **Results** screen use **Save to Google Drive**.

After editing `Code.gs` later, use **Deploy > Manage deployments > Edit > Version: New version > Deploy** so the same URL serves the new code.

## Notes

- "Anyone" access is needed so the browser app can reach the script without a Google sign-in; requests without the correct token are refused.
- Requests are sent as `text/plain` JSON, which avoids a CORS preflight that Apps Script does not answer.
- Each PDF is sent as one request. Apps Script limits a request to about 50 MB, far above a normal exam packet.
