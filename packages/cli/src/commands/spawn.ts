import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import ora from "ora";
import type { Command } from "commander";
import {
  loadConfig,
  findConfigFile,
  addProjectToConfig,
  generateConfigFromPath,
  decompose,
  getLeaves,
  getSiblings,
  formatPlanTree,
  TERMINAL_STATUSES,
  type OrchestratorConfig,
  type DecomposerConfig,
  DEFAULT_DECOMPOSER_CONFIG,
} from "@composio/ao-core";
import { exec } from "../lib/shell.js";
import { banner } from "../lib/format.js";
import { getSessionManager, getRegistry } from "../lib/create-session-manager.js";
import { ensureLifecycleWorker } from "../lib/lifecycle-service.js";
import { preflight } from "../lib/preflight.js";

interface SpawnClaimOptions {
  claimPr?: string;
  assignOnGithub?: boolean;
}

/**
 * Run pre-flight checks for a project once, before any sessions are spawned.
 * Validates runtime and tracker prerequisites so failures surface immediately
 * rather than repeating per-session in a batch.
 *
 * When the configured runtime lacks cross-process IPC (e.g. "process"),
 * auto-fallback to tmux if available. This prevents the silent failure mode
 * where ao spawn creates a session whose in-memory Map is lost on exit,
 * making ao send / lifecycle reactions unable to reach the worker.
 */
async function runSpawnPreflight(
  config: OrchestratorConfig,
  projectId: string,
  options?: SpawnClaimOptions,
): Promise<void> {
  const project = config.projects[projectId];
  const runtimeName = project?.runtime ?? config.defaults.runtime;

  // Check if configured runtime supports cross-process IPC
  if (runtimeName !== "tmux") {
    try {
      const registry = await getRegistry(config);
      const runtimePlugin = registry.get<{ crossProcessIPC?: boolean }>("runtime", runtimeName);
      if (runtimePlugin && runtimePlugin.crossProcessIPC === false) {
        // Process runtime: ao spawn exits → in-memory Map lost → ao send/lifecycle broken
        const tmuxAvailable = await preflight.isTmuxAvailable();
        if (tmuxAvailable) {
          console.log(
            chalk.yellow(
              `Runtime '${runtimeName}' lacks cross-process IPC. Auto-switching to tmux.`,
            ),
          );
          // Mutate in-memory config for this spawn flow (not written to disk)
          if (project?.runtime) {
            project.runtime = "tmux";
          } else {
            config.defaults.runtime = "tmux";
          }
        } else {
          console.log(
            chalk.yellow(
              `Warning: Runtime '${runtimeName}' lacks cross-process IPC and tmux is not available.\n` +
              `  Workers will only receive messages via file-based delivery (requires 'ao start' running).\n` +
              `  For full IPC support, install tmux or set defaults.runtime: tmux in config.`,
            ),
          );
        }
      }
    } catch {
      // Registry not available — proceed with configured runtime
    }
  }

  // Validate tmux if that's what we're using (either configured or auto-switched)
  const effectiveRuntime = project?.runtime ?? config.defaults.runtime;
  if (effectiveRuntime === "tmux") {
    await preflight.checkTmux();
  }

  const needsGitHubAuth =
    project?.tracker?.plugin === "github" ||
    (options?.claimPr && project?.scm?.plugin === "github");
  if (needsGitHubAuth) {
    await preflight.checkGhAuth();
  }
}

async function spawnSession(
  config: OrchestratorConfig,
  projectId: string,
  issueId?: string,
  openTab?: boolean,
  agent?: string,
  claimOptions?: SpawnClaimOptions,
): Promise<string> {
  const spinner = ora("Creating session").start();

  try {
    const sm = await getSessionManager(config);
    spinner.text = "Spawning session via core";

    const session = await sm.spawn({
      projectId,
      issueId,
      agent,
    });

    let branchStr = session.branch ?? "";
    let claimedPrUrl: string | null = null;

    if (claimOptions?.claimPr) {
      spinner.text = `Claiming PR ${claimOptions.claimPr}`;
      try {
        const claimResult = await sm.claimPR(session.id, claimOptions.claimPr, {
          assignOnGithub: claimOptions.assignOnGithub,
        });
        branchStr = claimResult.pr.branch;
        claimedPrUrl = claimResult.pr.url;
      } catch (err) {
        throw new Error(
          `Session ${session.id} was created, but failed to claim PR ${claimOptions.claimPr}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    spinner.succeed(
      claimedPrUrl
        ? `Session ${chalk.green(session.id)} created and claimed PR`
        : `Session ${chalk.green(session.id)} created`,
    );

    console.log(`  Worktree: ${chalk.dim(session.workspacePath ?? "-")}`);
    if (branchStr) console.log(`  Branch:   ${chalk.dim(branchStr)}`);
    if (claimedPrUrl) console.log(`  PR:       ${chalk.dim(claimedPrUrl)}`);

    const runtimeName = session.runtimeHandle?.runtimeName;
    const tmuxTarget = session.runtimeHandle?.id ?? session.id;
    if (runtimeName === "tmux" || !runtimeName) {
      console.log(`  Attach:   ${chalk.dim(`tmux attach -t ${tmuxTarget}`)}`);
    } else {
      console.log(`  Runtime:  ${chalk.dim(runtimeName)} (session: ${tmuxTarget})`);
    }
    console.log();

    // Open terminal tab if requested
    if (openTab) {
      try {
        await exec("open-iterm-tab", [tmuxTarget]);
      } catch {
        // Terminal plugin not available
      }
    }

    // Output for scripting
    console.log(`SESSION=${session.id}`);

    // Process runtime: stay alive and stream agent output so the user can
    // see what the worker is doing. Without tmux there's no way to "attach"
    // after ao spawn exits, so the session appears to vanish.
    if (runtimeName === "process" && session.runtimeHandle) {
      console.log(chalk.dim("Streaming agent output (Ctrl+C to detach)...\n"));
      const registry = await getRegistry(config);
      const runtimePlugin = registry.get<{
        getOutput(h: unknown, lines?: number): Promise<string>;
        isAlive(h: unknown): Promise<boolean>;
      }>("runtime", "process");

      if (runtimePlugin) {
        let lastOutput = "";
        const pollInterval = setInterval(async () => {
          try {
            const output = await runtimePlugin.getOutput(session.runtimeHandle, 40);
            if (output && output !== lastOutput) {
              // Print only new lines
              const newPart = lastOutput
                ? output.slice(output.indexOf(lastOutput.slice(-200)) + lastOutput.slice(-200).length)
                : output;
              if (newPart.trim()) process.stdout.write(newPart + "\n");
              lastOutput = output;
            }
          } catch {
            clearInterval(pollInterval);
          }
        }, 2_000);

        const checkAlive = setInterval(async () => {
          try {
            const alive = await runtimePlugin.isAlive(session.runtimeHandle!);
            if (!alive) {
              console.log(chalk.dim("\nAgent exited."));
              clearInterval(pollInterval);
              clearInterval(checkAlive);
              process.exit(0);
            }
          } catch {
            clearInterval(pollInterval);
            clearInterval(checkAlive);
          }
        }, 5_000);

        process.on("SIGINT", () => {
          clearInterval(pollInterval);
          clearInterval(checkAlive);
          console.log(chalk.dim("\nDetached. Agent continues in background."));
          console.log(chalk.dim(`  Check: ao session ls`));
          console.log(chalk.dim(`  Send:  ao send ${session.id} "message"`));
          process.exit(0);
        });

        await new Promise(() => {});
      }
    }

    return session.id;
  } catch (err) {
    spinner.fail("Failed to create or initialize session");
    throw err;
  }
}

export function registerSpawn(program: Command): void {
  program
    .command("spawn")
    .description("Spawn a single agent session")
    .argument("<project>", "Project ID from config")
    .argument("[issue]", "Issue identifier (e.g. INT-1234, #42) - must exist in tracker")
    .option("--open", "Open session in terminal tab")
    .option("--agent <name>", "Override the agent plugin (e.g. codex, claude-code)")
    .option("--claim-pr <pr>", "Immediately claim an existing PR for the spawned session")
    .option("--assign-on-github", "Assign the claimed PR to the authenticated GitHub user")
    .option("--decompose", "Decompose issue into subtasks before spawning")
    .option("--max-depth <n>", "Max decomposition depth (default: 3)")
    .action(
      async (
        projectId: string,
        issueId: string | undefined,
        opts: {
          open?: boolean;
          agent?: string;
          claimPr?: string;
          assignOnGithub?: boolean;
          decompose?: boolean;
          maxDepth?: string;
        },
      ) => {
        let config = loadConfig();
        if (!config.projects[projectId]) {
          // Auto-onboard: check if projectId resolves to a local path with .git/
          const expanded = projectId.startsWith("~/")
            ? join(homedir(), projectId.slice(2))
            : resolve(projectId);
          let onboarded = false;
          if (existsSync(join(expanded, ".git"))) {
            const { projectId: newId, projectConfig } = generateConfigFromPath(expanded);
            const configFilePath = config.configPath ?? findConfigFile() ?? "";
            if (configFilePath) {
              addProjectToConfig(configFilePath, newId, projectConfig);
              console.log(
                chalk.green(`Auto-onboarded project: ${newId} from ${expanded}`),
              );
              config = loadConfig(configFilePath);
              if (config.projects[newId]) {
                projectId = newId;
                onboarded = true;
              }
            }
          }
          if (!onboarded) {
            console.error(
              chalk.red(
                `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
              ),
            );
            process.exit(1);
          }
        }

        if (!opts.claimPr && opts.assignOnGithub) {
          console.error(chalk.red("--assign-on-github requires --claim-pr on `ao spawn`."));
          process.exit(1);
        }

        const claimOptions: SpawnClaimOptions = {
          claimPr: opts.claimPr,
          assignOnGithub: opts.assignOnGithub,
        };

        try {
          await runSpawnPreflight(config, projectId, claimOptions);
          await ensureLifecycleWorker(config, projectId);

          if (opts.decompose && issueId) {
            // Decompose the issue before spawning
            const project = config.projects[projectId];
            const decompConfig: DecomposerConfig = {
              ...DEFAULT_DECOMPOSER_CONFIG,
              ...(project.decomposer ?? {}),
              maxDepth: opts.maxDepth
                ? parseInt(opts.maxDepth, 10)
                : (project.decomposer?.maxDepth ?? 3),
            };

            const spinner = ora("Decomposing task...").start();
            const issueTitle = issueId;

            const plan = await decompose(issueTitle, decompConfig);
            const leaves = getLeaves(plan.tree);
            spinner.succeed(`Decomposed into ${chalk.bold(String(leaves.length))} subtasks`);

            console.log();
            console.log(chalk.dim(formatPlanTree(plan.tree)));
            console.log();

            if (leaves.length <= 1) {
              console.log(chalk.yellow("Task is atomic — spawning directly."));
              await spawnSession(config, projectId, issueId, opts.open, opts.agent, claimOptions);
            } else {
              // Create child issues and spawn sessions with lineage context
              const sm = await getSessionManager(config);
              console.log(chalk.bold(`Spawning ${leaves.length} sessions with lineage context...`));
              console.log();

              for (const leaf of leaves) {
                const siblings = getSiblings(plan.tree, leaf.id);
                try {
                  const session = await sm.spawn({
                    projectId,
                    issueId, // All work on the same parent issue for now
                    lineage: leaf.lineage,
                    siblings,
                    agent: opts.agent,
                  });
                  console.log(`  ${chalk.green("✓")} ${session.id} — ${leaf.description}`);
                } catch (err) {
                  console.error(
                    `  ${chalk.red("✗")} ${leaf.description} — ${err instanceof Error ? err.message : err}`,
                  );
                }
                await new Promise((r) => setTimeout(r, 500));
              }
            }
          } else {
            await spawnSession(config, projectId, issueId, opts.open, opts.agent, claimOptions);
          }
        } catch (err) {
          console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
          process.exit(1);
        }
      },
    );
}

export function registerBatchSpawn(program: Command): void {
  program
    .command("batch-spawn")
    .description("Spawn sessions for multiple issues with duplicate detection")
    .argument("<project>", "Project ID from config")
    .argument("<issues...>", "Issue identifiers")
    .option("--open", "Open sessions in terminal tabs")
    .action(async (projectId: string, issues: string[], opts: { open?: boolean }) => {
      const config = loadConfig();
      if (!config.projects[projectId]) {
        console.error(
          chalk.red(
            `Unknown project: ${projectId}\nAvailable: ${Object.keys(config.projects).join(", ")}`,
          ),
        );
        process.exit(1);
      }

      console.log(banner("BATCH SESSION SPAWNER"));
      console.log();
      console.log(`  Project: ${chalk.bold(projectId)}`);
      console.log(`  Issues:  ${issues.join(", ")}`);
      console.log();

      // Pre-flight once before the loop so a missing prerequisite fails fast
      try {
        await runSpawnPreflight(config, projectId);
        await ensureLifecycleWorker(config, projectId);
      } catch (err) {
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      const sm = await getSessionManager(config);
      const created: Array<{ session: string; issue: string }> = [];
      const skipped: Array<{ issue: string; existing: string }> = [];
      const failed: Array<{ issue: string; error: string }> = [];
      const spawnedIssues = new Set<string>();

      // Load existing sessions once before the loop to avoid repeated reads + enrichment.
      // Exclude terminal sessions so completed/merged sessions don't block respawning
      // (e.g. when an issue is reopened after its PR was merged).
      const existingSessions = await sm.list(projectId);
      const existingIssueMap = new Map(
        existingSessions
          .filter((s) => s.issueId && !TERMINAL_STATUSES.has(s.status))
          .map((s) => [s.issueId!.toLowerCase(), s.id]),
      );

      for (const issue of issues) {
        // Duplicate detection — check both existing sessions and same-run duplicates
        if (spawnedIssues.has(issue.toLowerCase())) {
          console.log(chalk.yellow(`  Skip ${issue} — duplicate in this batch`));
          skipped.push({ issue, existing: "(this batch)" });
          continue;
        }

        // Check existing sessions (pre-loaded before loop)
        const existingSessionId = existingIssueMap.get(issue.toLowerCase());
        if (existingSessionId) {
          console.log(chalk.yellow(`  Skip ${issue} — already has session ${existingSessionId}`));
          skipped.push({ issue, existing: existingSessionId });
          continue;
        }

        try {
          const session = await sm.spawn({ projectId, issueId: issue });
          created.push({ session: session.id, issue });
          spawnedIssues.add(issue.toLowerCase());
          console.log(chalk.green(`  Created ${session.id} for ${issue}`));

          if (opts.open) {
            try {
              const tmuxTarget = session.runtimeHandle?.id ?? session.id;
              await exec("open-iterm-tab", [tmuxTarget]);
            } catch {
              // best effort
            }
          }
        } catch (err) {
          failed.push({
            issue,
            error: err instanceof Error ? err.message : String(err),
          });
          console.log(
            chalk.red(`  Failed ${issue} — ${err instanceof Error ? err.message : String(err)}`),
          );
        }
      }

      console.log();
      if (created.length > 0) {
        console.log(chalk.green(`Created ${created.length} sessions:`));
        for (const item of created) console.log(`  ${item.session} ← ${item.issue}`);
      }
      if (skipped.length > 0) {
        console.log(chalk.yellow(`Skipped ${skipped.length} issues:`));
        for (const item of skipped) console.log(`  ${item.issue} (existing: ${item.existing})`);
      }
      if (failed.length > 0) {
        console.log(chalk.red(`Failed ${failed.length} issues:`));
        for (const item of failed) console.log(`  ${item.issue}: ${item.error}`);
      }
      console.log();
    });
}
