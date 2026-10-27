import express, { type Request, type Response } from 'express';
import { z } from 'zod';

import { claudeAccountsService } from '@/modules/providers/services/claude-accounts.service.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const accountId = z.uuid();
const name = z.string().trim().min(1).max(128).refine(value => !/[\x00-\x1f\x7f]/.test(value));
const loginInput = z.object({ accountId: accountId.optional(), name: name.optional() }).strict();
const activeInput = z.object({ id: z.union([accountId, z.literal('default'), z.null()]) }).strict();
const renameInput = z.object({ name }).strict();
const codeInput = z.object({ code: z.string().trim().min(1).max(4096) }).strict();
const refreshInput = z.object({ id: z.union([accountId, z.literal('default'), z.null()]).optional(), all: z.boolean().optional() }).strict();
const userId = (request: Request): unknown => (request as Request & { user?: { id?: unknown; userId?: unknown } }).user?.id ?? (request as Request & { user?: { userId?: unknown } }).user?.userId;
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('Invalid Claude account request.', { code: 'INVALID_CLAUDE_ACCOUNT_REQUEST', statusCode: 400 });
  return parsed.data;
}

/** Providers mounts this authenticated account adapter; all filesystem, login, ownership and quota work stays in its service. */
export function createClaudeAccountsRouter(service = claudeAccountsService) {
  const router = express.Router();
  router.get('/', asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(await service.getState(userId(req))));
  }));
  router.post('/login', asyncHandler(async (req: Request, res: Response) => {
    const input = parse(loginInput, req.body ?? {});
    res.status(201).json(createApiSuccessResponse(await service.startLogin(userId(req), input)));
  }));
  router.get('/login/:loginId', asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(service.getLogin(userId(req), parse(accountId, req.params.loginId))));
  }));
  router.post('/login/:loginId/code', asyncHandler(async (req: Request, res: Response) => {
    const parsed = codeInput.safeParse(req.body);
    if (!parsed.success) throw new AppError('未收到有效授权码，请粘贴 Claude 授权页面显示的授权码后重新提交。', { code: 'CLAUDE_LOGIN_CODE_INVALID', statusCode: 400 });
    const loginId = accountId.safeParse(req.params.loginId);
    if (!loginId.success) throw new AppError('本次登录标识无效，请取消后重新开始登录。', { code: 'CLAUDE_LOGIN_ID_INVALID', statusCode: 400 });
    res.json(createApiSuccessResponse(service.submitCode(userId(req), loginId.data, parsed.data.code)));
  }));
  router.delete('/login/:loginId', asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(await service.cancelLogin(userId(req), parse(accountId, req.params.loginId))));
  }));
  router.put('/active', asyncHandler(async (req: Request, res: Response) => {
    const input = parse(activeInput, req.body);
    res.json(createApiSuccessResponse(await service.select(userId(req), input.id === 'default' ? null : input.id)));
  }));
  router.post('/refresh', asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(await service.refresh(userId(req), parse(refreshInput, req.body ?? {}))));
  }));
  router.put('/:id', asyncHandler(async (req: Request, res: Response) => {
    const input = parse(renameInput, req.body);
    res.json(createApiSuccessResponse(await service.rename(userId(req), parse(accountId, req.params.id), input.name)));
  }));
  router.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
    res.json(createApiSuccessResponse(await service.remove(userId(req), parse(accountId, req.params.id))));
  }));
  return router;
}
