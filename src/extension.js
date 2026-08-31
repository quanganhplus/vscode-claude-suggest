const vscode = require('vscode');
const { ClaudeClient } = require('./claudeClient');
const { ClaudeCliClient } = require('./cliClient');
const { ClaudeInlineProvider } = require('./inlineProvider');
const {
  buildGenerateMessages,
  buildRefactorMessages,
  buildExplainMessages,
  stripCodeFences,
  getContext
} = require('./prompts');

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const apiClient = new ClaudeClient(context);
  const cliClient = new ClaudeCliClient(context, apiClient.output);

  const cfg = () => vscode.workspace.getConfiguration('claudeSuggest');
  const useCli = () => cfg().get('backend', 'cli') === 'cli';

  // Bộ định tuyến: cùng interface, chọn backend theo cấu hình tại thời điểm gọi.
  const client = {
    output: apiClient.output,
    log: (msg) => apiClient.log(msg),
    promptForApiKey: () => apiClient.promptForApiKey(),
    clearApiKey: () => apiClient.clearApiKey(),
    complete: (params) => {
      // params.backend cho phep inline dung backend khac voi cac lenh
      const target = params.backend && params.backend !== 'same' ? params.backend : (useCli() ? 'cli' : 'api');
      return target === 'cli' ? cliClient.complete(params) : apiClient.complete(params);
    }
  };

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'claudeSuggest.menu';
  context.subscriptions.push(statusBar);

  const refreshTooltip = () => {
    const md = new vscode.MarkdownString();
    md.appendMarkdown("**Claude Suggest Code**\n\n");
    md.appendMarkdown("| Phím | Chức năng |\n|---|---|\n");
    md.appendMarkdown("| `Alt+\\` | Gợi ý inline |\n");
    md.appendMarkdown("| `Alt+;` | Sinh code từ mô tả |\n");
    md.appendMarkdown("| `Alt+'` | Giải thích code đã chọn |\n");
    md.appendMarkdown("| `Alt+/` | Refactor code đã chọn |\n");
    md.appendMarkdown("\n\nBackend: **" + (useCli() ? "Claude Code CLI (thuê bao)" : "Anthropic API (credit)") + "**");
    md.appendMarkdown("\n\nTự động: **" + (cfg().get("autoSuggest", false) ? "BẬT" : "TẮT") + "**");
    md.appendMarkdown("\n\n_Bấm để mở bảng lệnh_");
    statusBar.tooltip = md;
  };
  refreshTooltip();
  statusBar.show();

  const provider = new ClaudeInlineProvider(client, statusBar);
  provider.setBusy(false);

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider)
  );

  // ---- Lệnh: bảng lệnh nhanh (mở khi bấm vào status bar) ----
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSuggest.menu', async () => {
      const auto = cfg().get('autoSuggest', false);
      const items = [
        { label: "$(sparkle) Gợi ý code tại con trỏ", description: "Alt+\\", cmd: "claudeSuggest.triggerInline" },
        { label: "$(add) Sinh code từ mô tả", description: "Alt+;", cmd: "claudeSuggest.generate" },
        { label: "$(book) Giải thích code đã chọn", description: "Alt+'", cmd: "claudeSuggest.explain" },
        { label: "$(wand) Refactor code đã chọn", description: "Alt+/", cmd: "claudeSuggest.refactor" },
        { label: "$(" + (auto ? "check" : "circle-slash") + ") Gợi ý tự động: " + (auto ? "BẬT" : "TẮT"), description: "bấm để đổi", cmd: "claudeSuggest.toggleAuto" },
        { label: "$(server) Backend: " + (useCli() ? "Claude Code CLI" : "Anthropic API"), description: "bấm để đổi", cmd: "claudeSuggest.switchBackend" },
        { label: "$(output) Mở log", description: "xem request & thời gian", cmd: "claudeSuggest.showLog" }
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: 'Claude Suggest Code',
        placeHolder: 'Chọn thao tác — phím tắt hiện bên phải'
      });
      if (pick) vscode.commands.executeCommand(pick.cmd);
    }),
    vscode.commands.registerCommand('claudeSuggest.showLog', () => client.output.show(true))
  );

  // ---- Lệnh: quản lý API key ----
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSuggest.setApiKey', () => client.promptForApiKey()),
    vscode.commands.registerCommand('claudeSuggest.clearApiKey', () => client.clearApiKey())
  );

  // ---- Lệnh: đổi backend ----
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSuggest.switchBackend', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: '$(terminal) Claude Code CLI',
            description: 'Dùng thuê bao Claude — không tốn credit API, chậm hơn ~1-3s mỗi lần gọi',
            value: 'cli'
          },
          {
            label: '$(cloud) Anthropic API',
            description: 'Gọi trực tiếp api.anthropic.com — nhanh, tính tiền theo token',
            value: 'api'
          }
        ],
        { title: 'Chọn backend cho Claude Suggest Code', ignoreFocusOut: true }
      );
      if (!pick) return;
      await cfg().update('backend', pick.value, vscode.ConfigurationTarget.Global);
      refreshTooltip();
      vscode.window.showInformationMessage(`Backend hiện tại: ${pick.value === 'cli' ? 'Claude Code CLI' : 'Anthropic API'}`);
    })
  );

  // ---- Lệnh nội bộ: chạy khi người dùng nhận (Tab) một gợi ý của Claude ----
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSuggest.suggestionAccepted', () => {
      client.log('Người dùng đã nhận gợi ý inline của Claude.');
      vscode.window.setStatusBarMessage('$(sparkle) Đã nhận gợi ý của Claude', 3000);
    })
  );

  // ---- Lệnh: gợi ý inline thủ công ----
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSuggest.triggerInline', async () => {
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    })
  );

  // ---- Lệnh: bật/tắt gợi ý tự động ----
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSuggest.toggleAuto', async () => {
      const current = cfg().get('autoSuggest', false);
      await cfg().update('autoSuggest', !current, vscode.ConfigurationTarget.Global);
      provider.setBusy(false);
      vscode.window.showInformationMessage(
        `Gợi ý tự động: ${!current ? 'BẬT' : 'TẮT'}${!current && useCli() ? ' — lưu ý backend CLI khá chậm cho chế độ này' : ''}`
      );
    })
  );

  // ---- Lệnh: sinh code từ mô tả / vùng chọn ----
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSuggest.generate', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selectedText = editor.document.getText(editor.selection).trim();
      const currentLine = editor.document.lineAt(editor.selection.active.line).text.trim();

      const instruction = await vscode.window.showInputBox({
        title: 'Claude — sinh code',
        prompt: 'Mô tả đoạn code bạn muốn sinh',
        value: selectedText || currentLine,
        ignoreFocusOut: true
      });
      if (!instruction || !instruction.trim()) return;

      const position = editor.selection.isEmpty ? editor.selection.active : editor.selection.end;
      const { before, after } = getContext(editor.document, position);

      const result = await runWithProgress('Claude đang sinh code…', (token) => {
        const { system, messages } = buildGenerateMessages({
          languageId: editor.document.languageId,
          fileName: editor.document.fileName.split(/[\\/]/).pop(),
          instruction: instruction.trim(),
          before,
          after
        });
        return client.complete({ system, messages, token, effort: cfg().get('effort', 'high') });
      });
      if (!result) return;

      const code = stripCodeFences(result);
      const insertPos = new vscode.Position(position.line, editor.document.lineAt(position.line).text.length);
      await editor.edit((edit) => edit.insert(insertPos, '\n' + code));
      vscode.window.setStatusBarMessage('$(check) Đã chèn code từ Claude (Ctrl+Z để hoàn tác)', 4000);
    })
  );

  // ---- Lệnh: giải thích code ----
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSuggest.explain', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection).trim();
      if (!selection) {
        vscode.window.showWarningMessage('Hãy bôi đen đoạn code cần giải thích.');
        return;
      }

      const result = await runWithProgress('Claude đang phân tích…', (token) => {
        const { system, messages } = buildExplainMessages({
          languageId: editor.document.languageId,
          fileName: editor.document.fileName.split(/[\\/]/).pop(),
          selection
        });
        return client.complete({ system, messages, token, effort: cfg().get('effort', 'high') });
      });
      if (!result) return;

      const doc = await vscode.workspace.openTextDocument({ content: result, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    })
  );

  // ---- Lệnh: refactor ----
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSuggest.refactor', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.document.getText(editor.selection);
      if (!selection.trim()) {
        vscode.window.showWarningMessage('Hãy bôi đen đoạn code cần refactor.');
        return;
      }

      const instruction = await vscode.window.showInputBox({
        title: 'Claude — refactor',
        prompt: 'Yêu cầu cụ thể (bỏ trống = cải thiện tổng quát)',
        placeHolder: 'ví dụ: tách thành hàm nhỏ, thêm xử lý lỗi, thêm type hint…',
        ignoreFocusOut: true
      });
      if (instruction === undefined) return;

      const { before, after } = getContext(editor.document, editor.selection.start);

      const result = await runWithProgress('Claude đang refactor…', (token) => {
        const { system, messages } = buildRefactorMessages({
          languageId: editor.document.languageId,
          selection,
          instruction: instruction.trim(),
          context: `${before}\n…\n${after}`
        });
        return client.complete({ system, messages, token, effort: cfg().get('effort', 'high') });
      });
      if (!result) return;

      const code = stripCodeFences(result);
      const targetRange = new vscode.Range(editor.selection.start, editor.selection.end);

      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(check) Áp dụng', value: 'apply' },
          { label: '$(diff) Xem trước ở tab mới', value: 'preview' },
          { label: '$(x) Huỷ', value: 'cancel' }
        ],
        { title: 'Kết quả refactor từ Claude', ignoreFocusOut: true }
      );
      if (!choice || choice.value === 'cancel') return;

      if (choice.value === 'preview') {
        const doc = await vscode.workspace.openTextDocument({
          content: code,
          language: editor.document.languageId
        });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
        return;
      }

      await editor.edit((edit) => edit.replace(targetRange, code));
      vscode.window.setStatusBarMessage('$(check) Đã áp dụng refactor (Ctrl+Z để hoàn tác)', 4000);
    })
  );

  // Cập nhật status bar khi đổi cấu hình
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeSuggest.autoSuggest')) { provider.setBusy(false); refreshTooltip(); }
      if (e.affectsConfiguration('claudeSuggest.backend')) refreshTooltip();
    })
  );

  client.log(`Claude Suggest Code đã kích hoạt. Backend: ${useCli() ? 'CLI' : 'API'}`);
}

/**
 * Chạy tác vụ kèm thông báo tiến trình có thể huỷ.
 * @param {string} title
 * @param {(token: vscode.CancellationToken) => Promise<string|undefined>} task
 */
function runWithProgress(title, task) {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: true },
    (_progress, token) => task(token)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
