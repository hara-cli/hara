import { redactSensitiveText, requestsCredentialDisclosure } from "../security/secrets.js";
import type { ExternalUserQuestionAnswers, ExternalUserQuestionRequest } from "./types.js";

export const EXTERNAL_USER_QUESTIONS_FEATURE = "external.questions.v1";
const record = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === "object" && !Array.isArray(value)
);
const safeString = (value: unknown, limit: number): value is string => (
  typeof value === "string" && value.trim().length > 0 && value.length <= limit
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  && redactSensitiveText(value).redactions.length === 0
);

/** A question can solicit a secret without an imperative such as "paste". Keep this stricter gate
 * local to input cards; architecture/setup questions about credentials must remain ordinary questions. */
const inputCredentialName = String.raw`(?:password|passcode|api[ -]?key|(?:access|auth(?:entication)?|session|refresh)[ -]?token|(?:ssh[ -]?)?private[ -]?key|secret|verification[ -]?code|one[ -]?time[ -]?(?:password|code)|otp)`;
const credentialInterrogative = new RegExp(
  String.raw`\b(?:what\s+(?:is|are)|tell\s+me)\s+(?:(?:your|the|a|an|current|login)\s+)*${inputCredentialName}\b`, "iu",
);
const bareCredentialInput = new RegExp(
  String.raw`^\s*(?:(?:your|the|current|login)\s+)?${inputCredentialName}\s*[:?？]\s*$`, "iu",
);
const credentialInputQuestion = (text: string): boolean => (
  requestsCredentialDisclosure(text)
  || credentialInterrogative.test(text)
  || bareCredentialInput.test(text)
  || /(?:你(?:的)?|您(?:的)?|当前|當前|登入|登录|登陆|登錄).{0,8}(?:密码|密碼|口令|密钥|密鑰|秘钥|私钥|私鑰|验证码|驗證碼|动态码|動態碼|令牌).{0,8}(?:是什么|多少|是啥|是什麼)/u.test(text)
  || /(?:请输入|請輸入|请填写|請填寫|请提供|請提供|输入|輸入|填入|提供|告诉我|告訴我).{0,12}(?:密码|密碼|口令|密钥|密鑰|秘钥|私钥|私鑰|验证码|驗證碼|动态码|動態碼|令牌)/u.test(text)
);

/** Reject malformed/secret requests as a whole; never silently remove a choice or change its meaning. */
export function normalizeExternalUserQuestions(value: unknown): ExternalUserQuestionRequest | null {
  if (!record(value) || !Array.isArray(value.questions) || value.questions.length === 0 || value.questions.length > 16) return null;
  const questions: ExternalUserQuestionRequest["questions"] = [];
  const ids = new Set<string>();
  for (const raw of value.questions) {
    if (!record(raw) || !safeString(raw.id, 160) || ids.has(raw.id)
      || ["__proto__", "constructor", "prototype"].includes(raw.id)
      || !safeString(raw.question, 8_000) || raw.isSecret === true) return null;
    for (const flag of ["multiSelect", "isOther", "isSecret"]) {
      if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") return null;
    }
    if (raw.header !== undefined && !safeString(raw.header, 160)) return null;
    let options: ExternalUserQuestionRequest["questions"][number]["options"];
    // Codex's official native schema uses null for legitimate free-form questions.
    if (raw.options !== undefined && raw.options !== null) {
      if (!Array.isArray(raw.options) || raw.options.length > 32) return null;
      const labels = new Set<string>();
      options = [];
      for (const option of raw.options) {
        if (!record(option) || !safeString(option.label, 160) || labels.has(option.label)
          || (option.description !== undefined && !safeString(option.description, 2_000))) return null;
        labels.add(option.label);
        options.push({ label: option.label, ...(option.description !== undefined ? { description: option.description as string } : {}) });
      }
    }
    const prose = [raw.question, raw.header, ...(options ?? []).flatMap((option) => [option.label, option.description])]
      .filter((text): text is string => typeof text === "string");
    // Check the actual fields independently: a benign header must not break an anchored short prompt.
    if (prose.some(credentialInputQuestion) || requestsCredentialDisclosure(prose.join("\n"))) return null;
    ids.add(raw.id);
    questions.push({
      id: raw.id,
      question: raw.question,
      ...(raw.header !== undefined ? { header: raw.header as string } : {}),
      ...(options ? { options } : {}),
      ...(raw.multiSelect !== undefined ? { multiSelect: raw.multiSelect as boolean } : {}),
      ...(raw.isOther !== undefined ? { isOther: raw.isOther as boolean } : {}),
      ...(raw.isSecret !== undefined ? { isSecret: false } : {}),
    });
  }
  const request = { questions };
  return Buffer.byteLength(JSON.stringify(request), "utf8") <= 64 * 1024 ? request : null;
}

/** Undefined means invalid; {} is a valid cancellation/partial reply. No implicit defaults exist. */
export function validateExternalUserAnswers(
  request: ExternalUserQuestionRequest,
  value: unknown,
): ExternalUserQuestionAnswers | undefined {
  if (!record(value) || Object.keys(value).length > request.questions.length) return undefined;
  const questions = new Map(request.questions.map((question) => [question.id, question]));
  const result: ExternalUserQuestionAnswers = {};
  for (const [id, raw] of Object.entries(value)) {
    const question = questions.get(id);
    if (!question || question.isSecret || !record(raw) || !Array.isArray(raw.answers)
      || Object.keys(raw).some((key) => key !== "answers")
      || raw.answers.length > (question.multiSelect ? 32 : 1)) return undefined;
    const labels = new Set(question.options?.map((option) => option.label) ?? []);
    const answers: string[] = [];
    for (const answer of raw.answers) {
      if (!safeString(answer, 4_000) || answers.includes(answer)
        || (labels.size > 0 && !labels.has(answer) && question.isOther !== true)) return undefined;
      answers.push(answer);
    }
    result[id] = { answers };
  }
  return Buffer.byteLength(JSON.stringify(result), "utf8") <= 32 * 1024 ? result : undefined;
}
