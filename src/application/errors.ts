/**
 * 用例层的业务错误
 *
 * src/application 不能引用传输层 app/shared/envelope.ts（ARCHITECTURE.md §3.3 application-only-contracts），
 * 所以这里用带字符串 code 的普通 Error 表达「参数 / 数据不合法」：
 * 传输层的 toEnvelopeError 会原样保留 Error 上的字符串 code，界面收到的错误码与 CodedError 一致。
 * code 的取值由单测与 ERROR_CODES.INVALID_ARGUMENT 对齐。
 */
export class InvalidInputError extends Error {
  readonly code = "INVALID_ARGUMENT";

  constructor(message: string) {
    super(message);
    this.name = "InvalidInputError";
  }
}
