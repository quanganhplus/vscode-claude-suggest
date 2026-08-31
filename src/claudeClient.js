const vscode = require('vscode');

const SECRET_KEY = 'claudeSuggest.apiKey';
const API_VERSION = '2023-06-01';

/**
 * Bọc lời gọi tới endpoint /v1/messages của Anthropic.
 * Dùng fetch có sẵn trong Node 18+ (VS Code 1.85+ chạy Node 18/20) nên không cần dependency.
 */
class ClaudeClient {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    this.output = vscode.window.createOutputChannel('Claude Suggest Code');
    context.subscriptions.push(this.output);
  }

  cfg() {
    return vscode.workspace.getConfiguration('claudeSuggest');
  }

  log(msg) {
    const ts = new Date().toISOString().substring(11, 19);
    this.output.appendLine(`[${ts}] ${msg}`);
  }

  /**
   * Lấy API key: ưu tiên SecretStorage, sau đó biến môi trường ANTHROPIC_API_KEY.
   * @param {{ prompt?: boolean }} opts
   */
  async getApiKey(opts = {}) {
    const { prompt = true } = opts;
    let key = await this.context.secrets.get(SECRET_KEY);
    if (!key && process.env.ANTHROPIC_API_KEY) {
      key = process.env.ANTHROPIC_API_KEY;
    }
    if (!key && prompt) {
      const pick = await vscode.window.showWarningMessage(
        'Chưa có Anthropic API key. Nhập ngay để dùng extension?',
        'Nhập API Key'
      );
      if (pick === 'Nhập API Key') {
        key = await this.promptForApiKey();
      }
    }
    return key;
  }

  async promptForApiKey() {
    const value = await vscode.window.showInputBox({
      title: 'Anthropic API Key',
      prompt: 'Dán API key (dạng sk-ant-...). Key được lưu trong SecretStorage của VS Code, không nằm trong settings.json.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (!v || !v.trim() ? 'Không được để trống' : undefined)
    });
    if (!value) return undefined;
    await this.context.secrets.store(SECRET_KEY, value.trim());
    vscode.window.showInformationMessage('Đã lưu API key.');
    return value.trim();
  }

  async clearApiKey() {
    await this.context.secrets.delete(SECRET_KEY);
    vscode.window.showInformationMessage('Đã xoá API key khỏi SecretStorage.');
  }

  /** Bóc message thật từ body lỗi của API. */
  parseApiError(raw) {
    try {
      const json = JSON.parse(raw);
      if (json && json.error && json.error.message) {
        return { message: json.error.message, type: json.error.type || '' };
      }
    } catch (_) {
      /* body không phải JSON */
    }
    return { message: (raw || '').substring(0, 300), type: '' };
  }

  /** Hiện thông báo lỗi kèm hành động phù hợp với từng loại lỗi. */
  async showApiError(status, raw) {
    const { message, type } = this.parseApiError(raw);
    const lower = (message || '').toLowerCase();

    // Hết credit: API trả 400 chứ không phải 402, nên phải nhận diện qua nội dung.
    if (lower.includes('credit balance')) {
      const pick = await vscode.window.showErrorMessage(
        'Tài khoản Anthropic API đã hết credit. Cần nạp credit ở Console (Plans & Billing) mới gọi được API.',
        'Mở trang Billing'
      );
      if (pick === 'Mở trang Billing') {
        vscode.env.openExternal(vscode.Uri.parse('https://platform.claude.com/settings/billing'));
      }
      return;
    }

    if (status === 401) {
      const pick = await vscode.window.showErrorMessage(
        `API key không hợp lệ (401): ${message}`,
        'Nhập lại API Key'
      );
      if (pick === 'Nhập lại API Key') await this.promptForApiKey();
      return;
    }

    if (status === 429) {
      vscode.window.showWarningMessage(`Bị giới hạn tốc độ (429): ${message}`);
      return;
    }

    if (status === 404 || lower.includes('model')) {
      const pick = await vscode.window.showErrorMessage(
        `Lỗi model (${status}): ${message}`,
        'Mở cài đặt'
      );
      if (pick === 'Mở cài đặt') {
        vscode.commands.executeCommand('workbench.action.openSettings', 'claudeSuggest.model');
      }
      return;
    }

    const pick = await vscode.window.showErrorMessage(
      `Claude API lỗi ${status}${type ? ` (${type})` : ''}: ${message}`,
      'Xem log'
    );
    if (pick === 'Xem log') this.output.show(true);
  }

  /**
   * Gọi Messages API và trả về text đã ghép.
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
  async complete(params) {
    const cfg = this.cfg();
    const apiKey = await this.getApiKey({ prompt: !params.silent });
    if (!apiKey) return undefined;

    const body = {
      model: params.model || cfg.get('model', 'claude-sonnet-5'),
      max_tokens: params.maxTokens || cfg.get('maxTokens', 2048),
      messages: params.messages
    };
    if (params.system) body.system = params.system;

    const effort = (params.effort || cfg.get('effort', '') || '').trim();
    if (effort) body.effort = effort;

    const controller = new AbortController();
    if (params.token) {
      params.token.onCancellationRequested(() => controller.abort());
    }

    const baseUrl = (cfg.get('baseUrl', 'https://api.anthropic.com') || '').replace(/\/+$/, '');

    let res;
    try {
      res = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (err) {
      if (err && (err.name === 'AbortError' || controller.signal.aborted)) return undefined;
      this.log(`Lỗi mạng: ${err && err.message}`);
      if (!params.silent) {
        vscode.window.showErrorMessage(`Không gọi được Claude API: ${err && err.message}`);
      }
      return undefined;
    }

    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      this.log(`HTTP ${res.status} - ${raw.substring(0, 800)}`);
      if (!params.silent) await this.showApiError(res.status, raw);
      return undefined;
    }

    const data = await res.json();
    // Model thế hệ mới có thể trả kèm block "thinking" -> chỉ lấy block text.
    const text = (data.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim();

    if (data.usage) {
      this.log(`model=${body.model} in=${data.usage.input_tokens} out=${data.usage.output_tokens} stop=${data.stop_reason}`);
    }
    return text;
  }
}

module.exports = { ClaudeClient, SECRET_KEY };
