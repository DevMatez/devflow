import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';
import { relayOutboxOnce, type EventRoute } from '@devflow/events';
import { runWithCorrelationId } from '@devflow/observability';
import { parseCredentialsKey } from '@devflow/integrations-core';
import { env } from '../config/env';
import { createSystemPingJob } from '../modules/system/jobs/system-ping.job';
import { createSystemPingRoute } from '../modules/system/routing';
import { createActivityProjectorJob } from '../modules/activity/jobs/activity-projector.job';
import { createActivityRoutes, IGNORED_EVENT_TYPES } from '../modules/activity/routing';
import { createCreateBranchJob } from '../modules/dev-workflow/jobs/create-branch.job';
import { createCreatePrJob } from '../modules/dev-workflow/jobs/create-pr.job';
import { createDevWorkflowRoutes } from '../modules/dev-workflow/routing';
import { createReconcileIssueJob } from '../modules/reconciliation/jobs/reconcile-issue.job';
import { createReconcilePrJob } from '../modules/reconciliation/jobs/reconcile-pr.job';
import {
  createReconciliationRoutes,
  createPrReconciliationRoutes,
} from '../modules/reconciliation/routing';

const RELAY_INTERVAL_MS = 2_000;

/**
 * Starts the outbox relay loop and the queue worker(s) that consume the jobs
 * it enqueues (§10). Wave 0 runs the worker in-process; it moves to a
 * dedicated `apps/worker` process once there's enough job volume to warrant it.
 */
export const outboxRelayPlugin = fp(async (app) => {
  const credentialsKey = parseCredentialsKey(env.INTEGRATION_CREDENTIALS_KEY);

  const systemPingJob = createSystemPingJob(app.log);
  const activityProjectorJob = createActivityProjectorJob(app.db, app.log);
  const createBranchJob = createCreateBranchJob(app.db, app.log, credentialsKey);
  const createPrJob = createCreatePrJob(app.db, app.log, credentialsKey);
  const reconcileIssueJob = createReconcileIssueJob(app.db, app.log);
  const reconcilePrJob = createReconcilePrJob(app.db, app.log);

  const routes: EventRoute[] = [
    createSystemPingRoute(systemPingJob),
    ...createActivityRoutes(activityProjectorJob),
    ...createDevWorkflowRoutes(createBranchJob, createPrJob),
    ...createReconciliationRoutes(reconcileIssueJob),
    ...createPrReconciliationRoutes(reconcilePrJob),
  ];

  const runInContext = <T>(correlationId: string, fn: () => T): T =>
    runWithCorrelationId(correlationId, fn);
  const workers = [
    systemPingJob.createWorker(app.redis, { runInContext }),
    activityProjectorJob.createWorker(app.redis, { runInContext }),
    createBranchJob.createWorker(app.redis, { runInContext }),
    createPrJob.createWorker(app.redis, { runInContext }),
    reconcileIssueJob.createWorker(app.redis, { runInContext }),
    reconcilePrJob.createWorker(app.redis, { runInContext }),
  ];

  const relayId = `api-${randomUUID()}`;
  const timer = setInterval(() => {
    relayOutboxOnce({
      db: app.db,
      routes,
      relayId,
      ignoredEventTypes: IGNORED_EVENT_TYPES,
    }).catch((error: unknown) => {
      app.log.error({ err: error }, 'outbox relay cycle failed');
    });
  }, RELAY_INTERVAL_MS);
  timer.unref();

  app.addHook('onClose', async () => {
    clearInterval(timer);
    await Promise.all(workers.map((worker) => worker.close()));
  });
});
