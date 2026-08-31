const vscode = require('vscode');

/** Chỉ dẫn thêm do người dùng cấu hình (coding convention của team...) */
function extraInstructions() {
  const extra = vscode.workspace.getConfiguration('claudeSuggest').get('extraInstructions', '');
  return extra && extra.trim() ? `\n\nQuy ước bổ sung của dự án:\n${extra.trim()}` : '';
}

const INLINE_SYSTEM = `Bạn là công cụ hoàn thiện code (fill-in-the-middle) chạy trong VS Code.

QUY TẮC BẮT BUỘC:
- Chỉ trả về ĐOẠN CODE cần chèn đúng tại vị trí con trỏ. Không giải thích, không markdown, không dấu \`\`\`.
- Tuyệt đối không lặp lại code đã có trong <code_before> hoặc <code_after>.
- Giữ đúng ngôn ngữ, style, quy ước đặt tên và mức thụt lề của file.
- Ưu tiên đoạn ngắn, đúng: 1-10 dòng. Nếu chỉ cần hoàn thiện nốt dòng hiện tại thì chỉ trả phần còn thiếu của dòng đó.
- Nếu không đủ ngữ cảnh để đoán chắc chắn, trả về chuỗi rỗng.`;

const GENERATE_SYSTEM = `Bạn là lập trình viên senior hỗ trợ viết code trong VS Code.
Trả về DUY NHẤT code hoàn chỉnh có thể chèn thẳng vào file, không kèm giải thích, không bọc markdown.
Giữ đúng ngôn ngữ và style của file hiện tại. Chú thích ngắn gọn bằng tiếng Việt khi logic phức tạp.`;

const REFACTOR_SYSTEM = `Bạn là lập trình viên senior chuyên refactor code.
Trả về DUY NHẤT phiên bản code đã cải thiện để thay thế trực tiếp đoạn được chọn, không kèm giải thích, không bọc markdown.
Giữ nguyên hành vi và chữ ký hàm public trừ khi bắt buộc phải đổi. Giữ nguyên mức thụt lề gốc.`;

const EXPLAIN_SYSTEM = `Bạn là lập trình viên senior giải thích code cho đồng nghiệp.
Trả lời bằng tiếng Việt, ngắn gọn, dùng markdown. Cấu trúc: mục đích tổng quan, luồng xử lý chính, các điểm cần lưu ý hoặc rủi ro tiềm ẩn.`;

function buildInlineMessages({ languageId, fileName, before, after }) {
  const user = [
    `Ngôn ngữ: ${languageId}`,
    `File: ${fileName}`,
    '',
    '<code_before>',
    before,
    '</code_before>',
    '<code_after>',
    after,
    '</code_after>',
    '',
    'Viết đoạn code chèn vào đúng giữa <code_before> và <code_after>.'
  ].join('\n');
  return { system: INLINE_SYSTEM + extraInstructions(), messages: [{ role: 'user', content: user }] };
}

function buildGenerateMessages({ languageId, fileName, instruction, before, after }) {
  const user = [
    `Ngôn ngữ: ${languageId}`,
    `File: ${fileName}`,
    '',
    'Yêu cầu:',
    instruction,
    '',
    '<code_before>',
    before,
    '</code_before>',
    '<code_after>',
    after,
    '</code_after>',
    '',
    'Viết code đáp ứng yêu cầu trên, phù hợp để chèn tại vị trí con trỏ.'
  ].join('\n');
  return { system: GENERATE_SYSTEM + extraInstructions(), messages: [{ role: 'user', content: user }] };
}

function buildRefactorMessages({ languageId, selection, instruction, context }) {
  const user = [
    `Ngôn ngữ: ${languageId}`,
    instruction ? `Yêu cầu cụ thể: ${instruction}` : 'Yêu cầu: cải thiện tính rõ ràng, xử lý lỗi và hiệu năng.',
    '',
    '<file_context>',
    context,
    '</file_context>',
    '',
    '<code_to_refactor>',
    selection,
    '</code_to_refactor>'
  ].join('\n');
  return { system: REFACTOR_SYSTEM + extraInstructions(), messages: [{ role: 'user', content: user }] };
}

function buildExplainMessages({ languageId, fileName, selection }) {
  const user = [
    `Ngôn ngữ: ${languageId}`,
    `File: ${fileName}`,
    '',
    '<code>',
    selection,
    '</code>',
    '',
    'Giải thích đoạn code trên.'
  ].join('\n');
  return { system: EXPLAIN_SYSTEM, messages: [{ role: 'user', content: user }] };
}

/** Gỡ bỏ ```lang ... ``` nếu model lỡ bọc markdown. */
function stripCodeFences(text) {
  if (!text) return '';
  let out = text.trim();
  const fence = out.match(/^```[a-zA-Z0-9+#.-]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) out = fence[1];
  else out = out.replace(/^```[a-zA-Z0-9+#.-]*\s*\n?/, '').replace(/\n?```$/, '');
  return out;
}

/** Lấy ngữ cảnh trước / sau con trỏ theo số dòng cấu hình. */
function getContext(document, position) {
  const cfg = vscode.workspace.getConfiguration('claudeSuggest');
  const linesBefore = cfg.get('contextLinesBefore', 120);
  const linesAfter = cfg.get('contextLinesAfter', 60);

  const startLine = Math.max(0, position.line - linesBefore);
  const endLine = Math.min(document.lineCount - 1, position.line + linesAfter);

  const before = document.getText(new vscode.Range(new vscode.Position(startLine, 0), position));
  const after = document.getText(
    new vscode.Range(position, document.lineAt(endLine).range.end)
  );
  return { before, after };
}

module.exports = {
  buildInlineMessages,
  buildGenerateMessages,
  buildRefactorMessages,
  buildExplainMessages,
  stripCodeFences,
  getContext
};
