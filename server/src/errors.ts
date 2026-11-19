export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string,
    public extra?: { warnings?: {field: string; phrase: string}[]; existingId?: string }) {
    super(message);
  }
}
export const invalid = (message = '请求字段不符合约定。') => new HttpError(422, 'INVALID_INPUT', message);
export const conflict = () => new HttpError(409, 'INVALID_STATE', '当前表决状态不允许此操作。');
export const missing = () => new HttpError(404, 'NOT_FOUND', '记录或接口不存在。');
