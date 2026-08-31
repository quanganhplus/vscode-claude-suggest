const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Backend gọi Claude Code CLI ở chế độ headless (claude -p).
 * Dùng thuê bao Claude (Pro/Max) thay vì credit API.
 *
 * Đánh đổi: mỗi lần gọi phải khởi động tiến trình Node của CLI (~1-3s) nên
 * chậm hơn gọi API trực tiếp; phù hợp với các lệnh thủ công hơn là ghost text.
 */
class ClaudeCliClient {
  /**
   * @param {vscode.ExtensionContext} context
   * @param {vscode.OutputChannel} output
   */
  constructor(context, output) {
    this.context = context;
    this.output = output;
  }

  cfg() {
    return vscode.workspace.getConfiguration('claudeSuggest');
  }

  log(msg) {
    const ts = new Date().toISOString().substring(11, 19);
    this.output.appendLine(`[${ts}] [cli] ${msg}`);
  }

  /** Tìm file thực thi của Claude Code. */
  resolveCliPath() {
    const custom = (this.cfg().get('cliPath', '') || '').trim();
    if (custom) return custom;

    if (process.platform === 'win32') {
      const npmPath = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
      if (fs.existsSync(npmPath)) return npmPath;
      return 'claude.cmd';
    }
    return 'claude';
  }

  /** CLI nhận cả alias ngắn (sonnet) lẫn model ID đầy đủ (claude-sonnet-5). */
  toCliModel(model) {
    const m = (model || '').trim();
    return m || 'sonnet';
  }

  /**
   * Gộp system + user thành một prompt gửi qua stdin.
   * Truyền qua stdin thay vì tham số dòng lệnh để không phải escape
   * dấu nháy / xuống dòng — vốn rất dễ vỡ trên Windows.
   */
  buildPrompt(system, messages) {
    const user = (messages || [])
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .filter(Boolean)
      .join('\n\n');
    return system ? `${system}\n\n---\n\n${user}` : user;
  }

  /** Mở terminal để người dùng tự đăng nhập (extension không xử lý thông tin đăng nhập). */
  openLoginTerminal() {
    const term = vscode.window.createTerminal('Claude Code Login');
    term.show(true);
    term.sendText('claude', true);
    vscode.window.showInformationMessage(
      'Trong terminal vừa mở, gõ /login và làm theo hướng dẫn. Đăng nhập xong thì quay lại thử tiếp.'
    );
  }

  async handleCliError(message, silent) {
    this.log(`Lỗi: ${message}`);
    if (silent) return;

    if (/not logged in|\/login/i.test(message)) {
      const pick = await vscode.window.showErrorMessage(
        'Claude Code CLI chưa đăng nhập. Cần đăng nhập bằng tài khoản Claude của bạn.',
        'Mở terminal đăng nhập'
      );
      if (pick === 'Mở terminal đăng nhập') this.openLoginTerminal();
      return;
    }

    if (/usage limit|rate limit|quota/i.test(message)) {
      vscode.window.showWarningMessage(`Đã chạm giới hạn sử dụng của thuê bao: ${message}`);
      return;
    }

    const pick = await vscode.window.showErrorMessage(`Claude Code CLI lỗi: ${message}`, 'Xem log');
    if (pick === 'Xem log') this.output.show(true);
  }

  /**
   * Cùng interface với ClaudeClient.complete().
   * @param {{
   *   system?: string,
   *   messages: Array<{role: string, content: any}>,
   *   model?: string,
   *   maxTokens?: number,
   *   token?: vscode.CancellationToken,
   *   silent?: boolean
   * }} params
   * @returns {Promise<string|undefined>}
   */
  complete(params) {
    const cfg = this.cfg();
    const cli = this.resolveCliPath();
    const model = this.toCliModel(params.model || cfg.get('model', 'sonnet'));
    const timeoutMs = cfg.get('cliTimeoutMs', 60000);
    const folders = vscode.workspace.workspaceFolders;
    const cwd = folders && folders.length ? folders[0].uri.fsPath : undefined;
    const prompt = this.buildPrompt(params.system, params.messages);

    // KHÔNG dùng --bare: cờ đó làm CLI bỏ qua bước đọc thông tin đăng nhập
    // và luôn báo 'Not logged in'.
    const args = ['-p', '--output-format', 'json', '--model', model];
    if (params.effort) args.push('--effort', params.effort);

    return new Promise((resolve) => {
      let child;
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };

      try {
        child = spawn(`"${cli}"`, args, { cwd, shell: true, windowsHide: true });
      } catch (err) {
        this.handleCliError(err && err.message ? err.message : String(err), params.silent);
        return finish(undefined);
      }

      let stdout = '';
      let stderr = '';
      const started = Date.now();

      const timer = setTimeout(() => {
        this.log(`Quá thời gian chờ ${timeoutMs}ms, đã huỷ tiến trình.`);
        try {
          child.kill();
        } catch (_) {
          /* ignore */
        }
        if (!params.silent) {
          vscode.window.showWarningMessage(
            `Claude Code CLI không phản hồi sau ${Math.round(timeoutMs / 1000)}s. Có thể tăng claudeSuggest.cliTimeoutMs.`
          );
        }
        finish(undefined);
      }, timeoutMs);

      const cancelSub = params.token
        ? params.token.onCancellationRequested(() => {
            try {
              child.kill();
            } catch (_) {
              /* ignore */
            }
            finish(undefined);
          })
        : undefined;

      const cleanup = () => {
        clearTimeout(timer);
        if (cancelSub) cancelSub.dispose();
      };

      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      child.on('error', (err) => {
        cleanup();
        this.handleCliError(
          `Không chạy được "${cli}". ${err && err.message}. Kiểm tra claudeSuggest.cliPath.`,
          params.silent
        );
        finish(undefined);
      });

      child.on('close', (code) => {
        cleanup();
        const elapsed = Date.now() - started;

        let json;
        try {
          json = JSON.parse(stdout);
        } catch (_) {
          /* không phải JSON */
        }

        if (!json) {
          this.log(`exit=${code} stdout=${stdout.substring(0, 300)} stderr=${stderr.substring(0, 300)}`);
          this.handleCliError(
            stderr.trim() || `Tiến trình kết thúc với mã ${code} nhưng không trả về JSON.`,
            params.silent
          );
          return finish(undefined);
        }

        if (json.is_error) {
          this.handleCliError(String(json.result || 'Lỗi không rõ'), params.silent);
          return finish(undefined);
        }

        const usage = json.usage || {};
        this.log(
          `model=${model} in=${usage.input_tokens || 0} out=${usage.output_tokens || 0} ` +
            `cost=$${json.total_cost_usd || 0} ${elapsed}ms`
        );
        finish(String(json.result || '').trim());
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }
}

module.exports = { ClaudeCliClient };
