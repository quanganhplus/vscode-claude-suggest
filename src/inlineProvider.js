const vscode = require('vscode');
const { buildInlineMessages, stripCodeFences, getContext } = require('./prompts');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Provider hiển thị gợi ý dạng ghost text.
 * - Chế độ tự động: chạy khi gõ (có debounce), bật/tắt qua claudeSuggest.autoSuggest
 * - Chế độ thủ công: luôn chạy khi người dùng nhấn Ctrl+Alt+Space
 */
class ClaudeInlineProvider {
  /**
   * @param {import('./claudeClient').ClaudeClient} client
   * @param {vscode.StatusBarItem} statusBar
   */
  constructor(client, statusBar) {
    this.client = client;
    this.statusBar = statusBar;
    this.cache = new Map();
    this.pending = false;
    this.flashTimer = undefined;
  }

  cfg() {
    return vscode.workspace.getConfiguration('claudeSuggest');
  }

  setBusy(busy) {
    this.pending = busy;
    if (!this.statusBar) return;
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = undefined;
    }
    const auto = this.cfg().get('autoSuggest', false);
    this.statusBar.text = busy
      ? '$(loading~spin) Claude đang nghĩ…'
      : auto
        ? '$(sparkle) Claude: auto'
        : '$(sparkle) Claude';
  }

  /** Nhấp nháy status bar để báo ghost text đang hiển thị là của Claude. */
  flashReady() {
    if (!this.statusBar) return;
    this.statusBar.text = '$(sparkle) Claude: có gợi ý';
    this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.statusBar.backgroundColor = undefined;
      this.setBusy(false);
    }, 5000);
  }

  cacheKey(document, position, before, after) {
    return `${document.uri.toString()}|${position.line}|${before.slice(-400)}|${after.slice(0, 200)}`;
  }

  remember(key, value) {
    if (this.cache.size > 40) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, value);
  }

  /** Tạo item kèm command để biết khi nào người dùng nhận gợi ý của Claude. */
  makeItem(text, position) {
    return new vscode.InlineCompletionItem(text, new vscode.Range(position, position), {
      command: 'claudeSuggest.suggestionAccepted',
      title: 'Claude Suggest Code'
    });
  }

  /**
   * @param {vscode.TextDocument} document
   * @param {vscode.Position} position
   * @param {vscode.InlineCompletionContext} context
   * @param {vscode.CancellationToken} token
   */
  async provideInlineCompletionItems(document, position, context, token) {
    const cfg = this.cfg();
    const isManual = context.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;

    if (!isManual) {
      if (!cfg.get('autoSuggest', false)) return;
      // Chi chay tu dong voi cac ngon ngu duoc liet ke (rong = moi ngon ngu)
      const allowed = cfg.get('autoSuggestLanguages', []);
      if (Array.isArray(allowed) && allowed.length && !allowed.includes(document.languageId)) return;
    }
    if (document.uri.scheme === 'output' || document.uri.scheme === 'vscode-scm') return;

    const disabled = cfg.get('disabledLanguages', []);
    if (Array.isArray(disabled) && disabled.includes(document.languageId)) return;

    // Chờ người dùng ngừng gõ trước khi gọi API (chỉ với chế độ tự động).
    if (!isManual) {
      await delay(cfg.get('debounceMs', 500));
      if (token.isCancellationRequested) return;
    }

    const { before, after } = getContext(document, position);
    if (!before.trim() && !after.trim()) return;

    const key = this.cacheKey(document, position, before, after);
    if (this.cache.has(key)) {
      const cached = this.cache.get(key);
      if (!cached) return;
      this.flashReady();
      return [this.makeItem(cached, position)];
    }

    this.setBusy(true);
    let raw;
    try {
      const { system, messages } = buildInlineMessages({
        languageId: document.languageId,
        fileName: document.fileName.split(/[\\/]/).pop(),
        before,
        after
      });

      raw = await this.client.complete({
        system,
        messages,
        model: cfg.get('inlineModel', 'claude-haiku-4-5-20251001'),
        maxTokens: cfg.get('inlineMaxTokens', 300),
        effort: cfg.get('inlineEffort', 'low'),
        backend: cfg.get('inlineBackend', 'same'),
        token,
        silent: !isManual
      });
    } finally {
      this.setBusy(false);
    }

    if (token.isCancellationRequested) return;

    const suggestion = this.postProcess(raw, document, position);
    this.remember(key, suggestion || '');
    if (!suggestion) return;

    this.client.log(`Gợi ý inline sẵn sàng (${suggestion.split('\n').length} dòng).`);
    this.flashReady();
    return [this.makeItem(suggestion, position)];
  }

  /** Dọn đầu ra: bỏ fence, bỏ phần trùng với text đã có quanh con trỏ. */
  postProcess(raw, document, position) {
    let text = stripCodeFences(raw || '');
    if (!text.trim()) return '';

    const line = document.lineAt(position.line);
    const linePrefix = line.text.substring(0, position.character);
    const lineSuffix = line.text.substring(position.character);

    // Model đôi khi lặp lại phần đầu dòng hiện tại -> cắt bỏ.
    const trimmedPrefix = linePrefix.trimStart();
    if (trimmedPrefix && text.startsWith(trimmedPrefix)) {
      text = text.substring(trimmedPrefix.length);
    } else if (linePrefix && text.startsWith(linePrefix)) {
      text = text.substring(linePrefix.length);
    }

    // Nếu con trỏ ở giữa dòng, chỉ giữ lại phần trước khi trùng với đuôi dòng.
    if (lineSuffix.trim() && text.includes(lineSuffix.trim())) {
      text = text.substring(0, text.indexOf(lineSuffix.trim()));
    }

    // Bỏ dòng trắng thừa ở cuối, giữ tối đa 1 newline kết thúc.
    text = text.replace(/\n{3,}$/, '\n');
    if (!text.trim()) return '';
    return text;
  }
}

module.exports = { ClaudeInlineProvider };
