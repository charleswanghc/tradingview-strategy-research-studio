# 隱私與資料流

本專案的 GitHub 庫提供程式原始碼與乾淨的發行包。每位使用者自行登入 TradingView、提供自己的 OpenAI API Key，並選擇本地研究資料夾。沒有共用的服務商帳號、雲端研究後台或內建 Key。

## 保存在本機

策略來源、各版 Pine、CSV／XLSX 原始報告、測試條件、比較摘要與 AI 分析存於選定的工作資料夾。接續對話時，原始對話另存於該次研究的 `conversation.txt`，網址、來源資訊、研究摘要與下一步保存在研究紀錄。來源匯入採用不可覆寫的寫入方式。建立工作目錄時加入 Git 忽略規則；這是降低誤提交風險的措施，無法阻止使用者強制加入檔案。

桌面設定及本機配對金鑰存於目前使用者的應用程式資料目錄。Windows 的 AI Key 經 CurrentUser DPAPI 加密；不能因此視為對已控制該使用者帳號的程式保密。Key 不會出現在狀態 API、報告或公開包。使用「清除 Key」可移除程式保存的 Key；如需撤銷，請到 API 供應商帳戶撤銷。

橋接擴充套件保存本機配對設定與研究執行記錄；TradingView 登入資訊由 Chrome／TradingView 自己管理。本程式不讀取密碼、匯出 Cookie 或要求 TradingView 登入權杖。報告下載可能先留在 Chrome Downloads 的 `LocalStrategyResearchStudio` 子目錄，再複製到工作位置；清除研究資料時亦請檢查下載目錄。

## 傳送到 TradingView

開始研究會將 Pine 程式放入使用者自己的 TradingView 編輯器，提交編譯、策略參數及回測日期。策略與這些設定因此會交給 TradingView。保存方式和資料處理依使用者與 TradingView 的服務條款及設定。

## 傳送到 OpenAI API

模型連線測試傳送 API Key 以驗證存取並取得模型清單。生成、翻寫或分析時，使用者需求、必要的策略來源、測試條件及已核對的回測摘要會送到 OpenAI API。接續對話的第一個 AI 請求包含匯入的對話文字，後續包含研究摘要、歷次分析與已核對的績效。完整 CSV／XLSX 檔不直接上傳；它們先在本機解析成摘要。Key 只用於直接對 OpenAI 的認證，不交給 TradingView 或模型提示。

使用分享網址時，本地服務會直接向 ChatGPT 讀取公開分享頁面；只接受 HTTPS 的 ChatGPT 分享網址，不傳送 API Key、Cookie 或登入資訊。私人或需登入的對話請由使用者直接貼上文字；分享頁面失效、遭存取限制或格式改變時，讀取會停止並提示文字替代方式。頁面腳本不會在本地執行。分享連結由 ChatGPT 管理，建立、撤銷及存取權限依 ChatGPT 設定。

AI 請求使用 `store:false`，不啟用工具與自動重試。這不等同供應商完全不保留資料，也不代表零資料保留帳戶。API 資料是否用於訓練及保存期限，依供應商政策與帳戶的分享／保留設定。請自行確認帳戶設定；[OpenAI API 資料說明](https://platform.openai.com/docs/guides/your-data)。使用 AI 前面板要求明確同意；停用 AI 的現有 Pine 回測不會呼叫 AI。

## 網路與發行

研究服務只綁定 `127.0.0.1`，命令橋接與面板均需要隨機本機金鑰。桌面視窗不啟用 Node integration，採用 sandbox 與 context isolation；網頁沒有可直接讀取作業系統的 preload API。本程式未加入遙測、廣告、雲端同步或自動上傳研究資料。

原始碼第一次建置會向 npm／Electron 下載相依套件；免安裝包已包含執行環境。本版沒有自動更新服務。使用者自行從 GitHub Releases 下載更新。

公開庫及下載包以明確檔案清單建立，排除原專案 Git 歷史、使用者策略、報表、下載、登入狀態、`.local` 與配對金鑰。請勿在公開 Issue 上附上自己的 Key、策略、報告或帶金鑰的面板 URL。
