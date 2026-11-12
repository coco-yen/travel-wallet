# Travel Wallet（GitHub Pages 純靜態版）

本版本專為 **GitHub Pages** 設計，無需 Netlify、無需 Node.js 建置步驟，直接上傳到 GitHub Repository 開啟 GitHub Pages 即可永久免費託管！

## 部署與使用三步驟
1. **建立 Google Sheets 資料庫**：將 `apps-script/Code.gs` 貼入 Google 試算表的 Apps Script，部署為網頁應用程式（執行身分：我，誰可以存取：所有人），取得 `/exec` 網址。
2. **上傳至 GitHub 開啟 GitHub Pages**：將本資料夾所有檔案上傳到 GitHub 儲存庫根目錄，到 **Settings -> Pages -> Branch 選擇 `main` / `/ (root)`** 儲存，幾十秒後即產生公開網址。
3. **在網頁填入個人設定**：開啟網站後點進「**7. 資料與金鑰設定**」，貼上你的 Google Apps Script 網址、試算表密鑰，以及你自己的 Gemini / OpenAI API Key（僅存於個人瀏覽器本機，絕不暴露在公開原始碼中）。
