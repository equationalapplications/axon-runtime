#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { AxonClient, newJobId } from './http.js';
import { Ledger } from '../controller/ledger.js';
import { CONTRACT_VERSION, type JobRequest } from '../contract/schema.js';

interface NodeEntry {
  node_id: string;
  base_url: string;
  token_env: string;
  default_repo?: string;
}

function loadNodes(path: string): NodeEntry[] {
  return JSON.parse(readFileSync(path, 'utf8')) as NodeEntry[];
}

function clientFor(nodeId: string, nodesPath: string): { client: AxonClient; entry: NodeEntry } {
  const entry = loadNodes(nodesPath).find((n) => n.node_id === nodeId);
  if (!entry) throw new Error(`axon: no node named ${nodeId} in ${nodesPath}`);
  const token = process.env[entry.token_env];
  if (!token) throw new Error(`axon: ${entry.token_env} is not set`);
  return { client: new AxonClient({ baseUrl: entry.base_url, token }), entry };
}

const program = new Command();
program
  .name('axon')
  .description('Dispatch subagent jobs to Axon worker nodes')
  .option('--nodes <path>', 'controller node inventory', process.env.AXON_NODES ?? 'deploy/controller/nodes.json')
  .option('--ledger <path>', 'controller ledger database', process.env.AXON_LEDGER ?? 'deploy/controller/ledger.db');

program
  .command('dispatch')
  .requiredOption('--node <node_id>')
  .requiredOption('--repo <url>')
  .option('--ref <ref>', 'branch, tag, or sha', 'main')
  .requiredOption('--goal-file <path>')
  .option('--output <mode>', 'patch | report', 'patch')
  .option('--max-steps <n>', 'harness step cap', '40')
  .option('--timeout <seconds>', 'wall clock cap', '1800')
  .option('--max-spend <usd>', 'per-job spend cap', '2')
  .option('--wait', 'poll until the job reaches a terminal status', false)
  .action(async (opts) => {
    const globals = program.opts();
    const { client } = clientFor(opts.node, globals.nodes);
    const job: JobRequest = {
      contract_version: CONTRACT_VERSION,
      job_id: newJobId(),
      repo: opts.repo,
      ref: opts.ref,
      goal: readFileSync(opts.goalFile, 'utf8'),
      context: [],
      constraints: {
        max_harness_steps: Number(opts.maxSteps),
        timeout_seconds: Number(opts.timeout),
        max_spend_usd: Number(opts.maxSpend),
      },
      output: opts.output,
    };
    const submitted = await client.dispatch(job);
    const ledger = new Ledger(globals.ledger);
    ledger.recordDispatch(job, opts.node);
    if (submitted.status === 'rejected') {
      console.error(JSON.stringify(submitted, null, 2));
      process.exitCode = 1;
      return;
    }
    if (!opts.wait) {
      console.log(JSON.stringify(submitted, null, 2));
      return;
    }
    const envelope = await client.wait(job.job_id);
    ledger.recordEnvelope(envelope, opts.node);
    console.log(JSON.stringify(envelope, null, 2));
  });

program
  .command('status')
  .requiredOption('--job <job_id>')
  .action(async (opts) => {
    const globals = program.opts();
    const ledger = new Ledger(globals.ledger);
    const nodeId = ledger.nodeFor(opts.job);
    if (!nodeId) throw new Error(`axon: ledger has no node for job ${opts.job}`);
    const { client } = clientFor(nodeId, globals.nodes);
    console.log(JSON.stringify(await client.status(opts.job), null, 2));
  });

program
  .command('cancel')
  .requiredOption('--job <job_id>')
  .action(async (opts) => {
    const globals = program.opts();
    const nodeId = new Ledger(globals.ledger).nodeFor(opts.job);
    if (!nodeId) throw new Error(`axon: ledger has no node for job ${opts.job}`);
    const { client } = clientFor(nodeId, globals.nodes);
    console.log(JSON.stringify({ cancelled: await client.cancel(opts.job) }));
  });

program
  .command('nodes')
  .description('list configured nodes with their last-known status')
  .action(async () => {
    const globals = program.opts();
    for (const entry of loadNodes(globals.nodes)) {
      try {
        const { client } = clientFor(entry.node_id, globals.nodes);
        console.log(entry.node_id, JSON.stringify(await client.nodeinfo()));
      } catch (err) {
        console.log(entry.node_id, 'unreachable:', (err as Error).message);
      }
    }
  });

program
  .command('artifact')
  .requiredOption('--job <job_id>')
  .option('--id <artifact_id>', 'artifact name', 'patch.diff')
  .requiredOption('-o, --out <path>')
  .action(async (opts) => {
    const globals = program.opts();
    const nodeId = new Ledger(globals.ledger).nodeFor(opts.job);
    if (!nodeId) throw new Error(`axon: ledger has no node for job ${opts.job}`);
    const { client } = clientFor(nodeId, globals.nodes);
    writeFileSync(opts.out, await client.artifact(opts.job, opts.id), 'utf8');
    console.log(`wrote ${opts.out}`);
  });

program
  .command('metrics')
  .requiredOption('--node <node_id>')
  .action(async (opts) => {
    console.log(JSON.stringify(new Ledger(program.opts().ledger).metricsFor(opts.node), null, 2));
  });

await program.parseAsync(process.argv);
