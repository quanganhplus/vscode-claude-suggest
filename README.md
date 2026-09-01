# Claude Suggest Code

Extension VS Code gợi ý code bằng Claude API: ghost text inline + lệnh sinh / giải thích / refactor code.

## Cài đặt & chạy thử

1. Clone repo rồi mở bằng VS Code:
   ```bash
   git clone https://github.com/quanganhplus/vscode-claude-suggest.git
   cd vscode-claude-suggest
   code .
   ```
2. Nhấn `F5` → mở cửa sổ **Extension Development Host** đã nạp sẵn extension.
3. Trong cửa sổ mới: `Ctrl+Shift+P` → **Claude: Nhập / cập nhật API Key** → dán key `sk-ant-...`.
4. Mở một file code bất kỳ và thử `Ctrl+Alt+Space`.

Không cần `npm install` để chạy (extension không có runtime dependency, dùng `fetch` built-in của Node 18+).
Chạy `npm install` chỉ để có gợi ý kiểu khi sửa code.

## Cài cố định vào VS Code (không cần F5)

```powershell
npm install -g @vscode/vsce
cd vscode-claude-suggest
vsce package        # tạo claude-suggest-code-0.1.0.vsix
code --install-extension claude-suggest-code-0.1.0.vsix
```

Cách nhanh hơn (không cần đóng gói): copy cả thư mục vào `%USERPROFILE%\.vscode\extensions\claude-suggest-code-0.1.0` rồi khởi động lại VS Code.

## Phím tắt

| Phím | Chức năng |
|---|---|
| `Ctrl+Alt+Space` | Gợi ý code tại con trỏ (ghost text, `Tab` để nhận) |
| `Ctrl+Alt+G` | Sinh code từ mô tả |
| `Ctrl+Alt+E` | Giải thích đoạn code đã chọn |
| `Ctrl+Alt+R` | Refactor đoạn code đã chọn |

Bấm vào mục **Claude** ở thanh trạng thái để bật/tắt gợi ý tự động.

## Cấu hình chính (`Ctrl+,` → tìm "claudeSuggest")

| Setting | Mặc định | Ghi chú |
|---|---|---|
| `claudeSuggest.model` | `claude-sonnet-5` | Model cho lệnh sinh / giải thích / refactor |
| `claudeSuggest.inlineModel` | `claude-haiku-4-5-20251001` | Model cho ghost text — chọn model nhanh |
| `claudeSuggest.autoSuggest` | `false` | Bật = gọi API mỗi lần ngừng gõ, tốn token |
| `claudeSuggest.debounceMs` | `500` | Thời gian chờ trước khi gọi API |
| `claudeSuggest.contextLinesBefore/After` | `120` / `60` | Số dòng ngữ cảnh gửi lên |
| `claudeSuggest.effort` | `""` | Chỉ dùng với model thế hệ 5; để trống nếu model không hỗ trợ |
| `claudeSuggest.baseUrl` | `https://api.anthropic.com` | Đổi nếu đi qua gateway nội bộ |
| `claudeSuggest.extraInstructions` | `""` | Coding convention của team, được nối vào system prompt |

## Lưu ý

- **API key** lưu trong SecretStorage của VS Code (không nằm trong `settings.json`). Có thể thay bằng biến môi trường `ANTHROPIC_API_KEY`.
- **Dữ liệu gửi đi**: mỗi lần gợi ý, phần code quanh con trỏ được gửi lên API. Không bật `autoSuggest` khi làm việc với source code nội bộ / dữ liệu nhạy cảm.
- Model `claude-sonnet-5` có adaptive thinking luôn bật nên chậm hơn — đó là lý do inline mặc định dùng Haiku.
- Danh sách model ID mới nhất: https://platform.claude.com/docs/en/about-claude/models/overview
- Log & lỗi API: **Output** → chọn kênh **Claude Suggest Code**.

## Cấu trúc

```
src/extension.js       – đăng ký lệnh, phím tắt, status bar
src/claudeClient.js    – gọi /v1/messages, quản lý API key, xử lý lỗi
src/inlineProvider.js  – InlineCompletionItemProvider (ghost text) + cache/debounce
src/prompts.js         – system prompt, dựng ngữ cảnh, dọn output
```

## Hướng mở rộng

- Streaming (`"stream": true`) để chèn code dần thay vì chờ trọn phản hồi.
- Thêm ngữ cảnh từ các file đang mở hoặc từ import để gợi ý sát dự án hơn.
- Prompt caching cho phần ngữ cảnh file để giảm chi phí token khi gọi liên tục.
