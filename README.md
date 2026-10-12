# zh-tw-dictation

Claude Code 的 mod：把輸入框裡的簡體中文（例如內建語音輸入聽寫出來的字）轉成繁體中文、台灣用語（OpenCC s2twp），
另外可以按一個快捷鍵，把輸入框的文字送到 [Voice Hunter](#voice-hunter-api-校正) 的文字優化 API 做 AI 校正。

## 安裝

在 Claude Code 的終端機輸入：

```
/plugin install zh-tw-dictation --marketplace Stoneeu/zh-tw-dictation
```

問「Add marketplace?」時按 `y`，範圍選 user（第一個），按 Enter。裝好就生效，不用重開。

需要支援 mod（hooks module）的 Claude Code，在 2.1.296 測試過。

## 簡轉繁

不用設定，裝好就會：

- 語音聽寫或打字停下來 1 秒後，把輸入框裡的簡體換成繁體。
- 打字、貼上單行文字時當下就換。
- 按 Enter 送出時再檢查一次。

只在真的有簡體字時才動手：你自己打的繁體（例如「台北」）會原樣保留，不會被改成「臺北」。
反引號和 ``` 區塊裡的程式碼不會轉。

## Voice Hunter API 校正

預設關閉。打開後輸入框上方會出現 `[ API 校正 ]` 按鈕，按下按鈕或快捷鍵，就把整個輸入框送到
`POST /v1/text/optimize`，再用回傳的文字取代輸入框。Enter 和停頓都不會呼叫 API。

1. **打開並設定網址：** `/config` 裡的「API 校正按鈕」和「API 校正網址」，或執行
   `claude plugin configure zh-tw-dictation`。網址預設是 `http://127.0.0.1:8765/v1/text/optimize`。
2. **設定快捷鍵：** mod 不能自己綁按鍵，要在 `~/.claude/keybindings.json` 加上這段（檔案已存在就合併進去）：

   ```json
   {
     "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
     "$docs": "https://code.claude.com/docs/en/keybindings",
     "bindings": [
       {
         "context": "Global",
         "bindings": {
           "alt+j": "diff:back"
         }
       }
     ]
   }
   ```

   - `alt+j` 可以換成別的鍵，存檔就生效。
   - `"context"` 一定要是 `Global`，綁在 `Chat` 按鈕收不到。
   - `"diff:back"` 不能換：按鈕是透過這個 action 接收按鍵的。它本來只在 diff 對話框裡作用，所以在輸入框按不會有別的效果。
   - `alt` 加標點（例如 `alt+.`）在終端機裡不會被當成快捷鍵，只會輸入那個符號。

3. **金鑰（選用）：** Voice Hunter 有開金鑰驗證的話，啟動 Claude Code 前設定環境變數 `VOICE_HUNTER_API_KEY`，
   請求會帶 `Authorization: Bearer <金鑰>`。

失敗時（連不上、非 2xx、30 秒沒回應、校正期間你又改了輸入框），輸入框保持原文，並跳出提示說明原因。
回傳的內容會原樣放進輸入框，按 Enter 也原樣送出；繁簡由 Voice Hunter 自己的設定決定。
文字是用你設定的網址傳送，`http://` 網址不加密。

## 開發

```
hooks/register.tsx   掛在 Claude Code 上的 hooks：輸入框、送出、API 按鈕
hooks/convert.ts     OpenCC s2twp 轉換，以及判斷哪些字算簡體
dict/                OpenCC 1.4.2 的 s2twp 字典
tests/               claude plugin test 跑的測試
```

```
claude plugin validate .
claude plugin test .
```

## 授權

mod 的程式碼採用 MIT License，見 `LICENSE`。`dict/` 裡的字典取自 [OpenCC](https://github.com/BYVoid/OpenCC)，Apache License 2.0，見 `dict/LICENSE`。
