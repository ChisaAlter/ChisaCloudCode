import express from 'express';

import type { createSystemUpdateService } from './system.service.js';

/** Creates thin system routes that delegate update execution to the service. */
export function createSystemRouter(
  systemUpdateService: ReturnType<typeof createSystemUpdateService>,
  identity: Readonly<{ version: string | null; commit: string | null; dirty: boolean | null; builtAt: string | null }>,
): express.Router {
  const router = express.Router();

  router.get('/version', (_request, response) => response.json(identity));

  router.post('/update', async (_request, response, next) => {
    try {
      const result = await systemUpdateService.updateSystem();
      response.status(result.success ? 200 : 500).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
