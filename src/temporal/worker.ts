import { Worker, NativeConnection } from '@temporalio/worker';
import * as activities from './activities';

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'bankmesh',
    workflowsPath: require.resolve('./workflows'),
    activities,
    maxConcurrentActivityTaskExecutions: 50,
    maxConcurrentWorkflowTaskExecutions: 25,
  });

  process.on('SIGTERM', () => worker.shutdown());
  process.on('SIGINT',  () => worker.shutdown());

  console.log(`[worker] task_queue=${worker.options.taskQueue} ready`);
  await worker.run();
  console.log('[worker] shutdown complete');
}

main().catch((err) => {
  console.error('[worker] fatal', err);
  process.exit(1);
});
