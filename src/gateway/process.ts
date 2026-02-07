import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { buildEnvVars } from './env';
import { mountR2Storage } from './r2';

let startupInProgress = false;
let startupPromise: Promise<Process> | null = null;

/**
 * Find an existing Moltbot gateway process
 * 
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    const processes = await sandbox.listProcesses();
    for (const proc of processes) {
      // Only match the gateway process, not CLI commands like "clawdbot devices list"
      // Note: CLI is still named "clawdbot" until upstream renames it
      const isGatewayProcess = 
        proc.command.includes('start-moltbot.sh') ||
        proc.command.includes('clawdbot gateway');
      const isCliCommand = 
        proc.command.includes('clawdbot devices') ||
        proc.command.includes('clawdbot --version');
      
      if (isGatewayProcess && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Ensure the Moltbot gateway is running
 * 
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Wait for it to be ready, or start a new one
 * 
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv): Promise<Process> {
  // Prevent concurrent startup attempts
  if (startupInProgress && startupPromise) {
    console.log('[Gateway] Startup already in progress, waiting for existing attempt...');
    return startupPromise;
  }

  // Mark startup as in progress
  startupInProgress = true;
  
  startupPromise = (async () => {
    try {
      // Mount R2 storage for persistent data (non-blocking if not configured)
      // R2 is used as a backup - the startup script will restore from it on boot
      await mountR2Storage(sandbox, env);

      // Check if Moltbot is already running or starting
      const existingProcess = await findExistingMoltbotProcess(sandbox);
      if (existingProcess) {
        console.log('Found existing Moltbot process:', existingProcess.id, 'status:', existingProcess.status);
        // Use extended startup timeout - process can be "running" but not ready yet
        try {
          console.log('Waiting for Moltbot gateway on port', MOLTBOT_PORT, 'timeout: 120000ms');
          await existingProcess.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: 120000 });
          console.log('Moltbot gateway is reachable');
          return existingProcess;
        } catch (e) {
          // Timeout waiting for port - process is likely dead or stuck, kill and restart
          console.log('Existing process not reachable after 120s, killing and restarting...');
          try {
            await existingProcess.kill();
          } catch (killError) {
            console.log('Failed to kill process:', killError);
          }
        }
      }

      // Start a new Moltbot gateway
      console.log('Starting new Moltbot gateway...');
      const envVars = buildEnvVars(env);
      const command = '/usr/local/bin/start-moltbot.sh';
      console.log('Starting process with command:', command);
      console.log('Environment vars being passed:', Object.keys(envVars));
      
      let process: Process;
      try {
        process = await sandbox.startProcess(command, {
          env: Object.keys(envVars).length > 0 ? envVars : undefined,
        });
        console.log('Process started with id:', process.id, 'status:', process.status);
      } catch (startErr) {
        console.error('Failed to start process:', startErr);
        throw startErr;
      }

      // Wait for the gateway to be ready with extended timeout
      try {
        console.log('[Gateway] Waiting for Moltbot gateway to be ready on port', MOLTBOT_PORT, '(120 second timeout)');
        await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: 120000 });
        console.log('[Gateway] Moltbot gateway is ready!');
        const logs = await process.getLogs();
        if (logs.stdout) console.log('[Gateway] startup stdout:', logs.stdout.slice(0, 500));
        if (logs.stderr) console.log('[Gateway] startup stderr:', logs.stderr.slice(0, 500));
      } catch (e) {
        console.error('[Gateway] waitForPort failed after 120 seconds:', e);
        try {
          const logs = await process.getLogs();
          console.error('[Gateway] Process stdout:', logs.stdout ? logs.stdout.slice(0, 1000) : '(empty)');
          console.error('[Gateway] Process stderr:', logs.stderr ? logs.stderr.slice(0, 1000) : '(empty)');
          const errorMsg = logs.stderr || logs.stdout || 'Unknown error';
          throw new Error(`Moltbot gateway failed to start on port 18789 within 120 seconds. Error: ${errorMsg}`);
        } catch (logErr) {
          console.error('[Gateway] Failed to get logs:', logErr);
          throw e;
        }
      }

      // Verify gateway is actually responding
      console.log('[Gateway] Verifying gateway health...');
      
      return process;
    } finally {
      startupInProgress = false;
    }
  })();

  return startupPromise;
}
