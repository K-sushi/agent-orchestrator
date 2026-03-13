/**
 * Smoke tests for auto-onboard — exercises the EXACT code path that
 * `ao start <local-path>` and `ao spawn <local-path>` use:
 *
 *   1. generateConfigFromPath(expanded)
 *   2. addProjectToConfig(configFilePath, newId, projectConfig)
 *   3. loadConfig(configFilePath) — Zod validation round-trip
 *
 * Uses REAL repos on disk (trading-system, agent-orchestrator).
 * Does NOT start tmux/dashboard — only tests config generation + persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { generateConfigFromPath } from "../config-generator.js";
import { addProjectToConfig, loadConfig } from "../config.js";

// Real repos — skip suite if they don't exist (CI environments)
const TRADING_SYSTEM = resolve("C:/Users/hkmen/trading-system");
const AGENT_ORCHESTRATOR = resolve("C:/Users/hkmen/agent-orchestrator");

const hasRealRepos =
  existsSync(join(TRADING_SYSTEM, ".git")) &&
  existsSync(join(AGENT_ORCHESTRATOR, ".git"));

describe.skipIf(!hasRealRepos)("auto-onboard smoke (real repos)", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ao-smoke-"));
    configPath = join(tmpDir, "agent-orchestrator.yaml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // CASE 1: Empty config file → ao start <git repo>
  // =========================================================================
  it("Case 1: onboards trading-system into a fresh empty config", () => {
    // Start with minimal valid config (loadConfig needs at least `projects: {}`)
    writeFileSync(configPath, "port: 3001\nprojects: {}\n");

    // --- Exact code path from start.ts:80-91 ---
    const { projectId, projectConfig } = generateConfigFromPath(TRADING_SYSTEM);
    addProjectToConfig(configPath, projectId, projectConfig);

    // Verify: YAML written correctly
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const projects = parsed.projects as Record<string, Record<string, unknown>>;

    expect(projects[projectId]).toBeDefined();
    expect(projects[projectId].repo).toBe("K-sushi/trading-system");
    expect(projects[projectId].name).toBe("trading-system");
    expect(resolve(projects[projectId].path as string)).toBe(resolve(TRADING_SYSTEM));
    expect(["main", "master"]).toContain(projects[projectId].defaultBranch);
    expect(projects[projectId].sessionPrefix).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(parsed.port).toBe(3001); // preserved

    // Verify: loadConfig (Zod) accepts the written file
    const loaded = loadConfig(configPath);
    expect(loaded.projects[projectId]).toBeDefined();
    expect(loaded.projects[projectId].repo).toBe("K-sushi/trading-system");

    console.log(`  ✓ projectId: ${projectId}`);
    console.log(`  ✓ repo: ${projects[projectId].repo}`);
    console.log(`  ✓ path: ${projects[projectId].path}`);
    console.log(`  ✓ prefix: ${projects[projectId].sessionPrefix}`);
    console.log(`  ✓ symlinks: ${JSON.stringify(projects[projectId].symlinks)}`);
    console.log(`  ✓ Zod loadConfig: PASS`);
  });

  // =========================================================================
  // CASE 2: Existing YAML with one project → add second project
  // =========================================================================
  it("Case 2: adds agent-orchestrator to config that already has trading-system", () => {
    // Seed with trading-system first
    writeFileSync(configPath, "port: 3001\nprojects: {}\n");
    const ts = generateConfigFromPath(TRADING_SYSTEM);
    addProjectToConfig(configPath, ts.projectId, ts.projectConfig);

    // Now onboard agent-orchestrator
    const ao = generateConfigFromPath(AGENT_ORCHESTRATOR);
    addProjectToConfig(configPath, ao.projectId, ao.projectConfig);

    // Verify: both projects exist
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const projects = parsed.projects as Record<string, Record<string, unknown>>;

    // trading-system preserved
    expect(projects[ts.projectId]).toBeDefined();
    expect(projects[ts.projectId].repo).toBe("K-sushi/trading-system");

    // agent-orchestrator added
    expect(projects[ao.projectId]).toBeDefined();
    expect(projects[ao.projectId].repo).toMatch(/agent-orchestrator/);

    // No cross-contamination
    expect(projects[ts.projectId].path).not.toBe(projects[ao.projectId].path);
    expect(projects[ts.projectId].sessionPrefix).not.toBe(projects[ao.projectId].sessionPrefix);

    // Zod validation
    const loaded = loadConfig(configPath);
    expect(Object.keys(loaded.projects)).toHaveLength(2);

    console.log(`  ✓ Project 1: ${ts.projectId} → ${projects[ts.projectId].repo}`);
    console.log(`  ✓ Project 2: ${ao.projectId} → ${projects[ao.projectId].repo}`);
    console.log(`  ✓ sessionPrefix unique: ${projects[ts.projectId].sessionPrefix} ≠ ${projects[ao.projectId].sessionPrefix}`);
    console.log(`  ✓ Zod loadConfig (2 projects): PASS`);
  });

  // =========================================================================
  // CASE 3: Idempotency — same repo twice, no duplication, no corruption
  // =========================================================================
  it("Case 3: double-onboard is idempotent (same repo twice)", () => {
    writeFileSync(configPath, "port: 3001\nprojects: {}\n");

    // First onboard
    const run1 = generateConfigFromPath(TRADING_SYSTEM);
    addProjectToConfig(configPath, run1.projectId, run1.projectConfig);
    const after1 = readFileSync(configPath, "utf-8");

    // Second onboard (identical)
    const run2 = generateConfigFromPath(TRADING_SYSTEM);
    addProjectToConfig(configPath, run2.projectId, run2.projectConfig);
    const after2 = readFileSync(configPath, "utf-8");

    // projectId must be stable
    expect(run1.projectId).toBe(run2.projectId);

    // sessionPrefix must be stable
    expect(run1.projectConfig.sessionPrefix).toBe(run2.projectConfig.sessionPrefix);

    // path must be identical (no drift from resolve())
    expect(run1.projectConfig.path).toBe(run2.projectConfig.path);

    // YAML should have exactly 1 project (second write overwrites same key)
    const parsed = parseYaml(after2) as Record<string, unknown>;
    const projects = parsed.projects as Record<string, Record<string, unknown>>;
    const projectKeys = Object.keys(projects);
    expect(projectKeys).toHaveLength(1);
    expect(projectKeys[0]).toBe(run1.projectId);

    // Zod validation
    const loaded = loadConfig(configPath);
    expect(Object.keys(loaded.projects)).toHaveLength(1);

    // port preserved both times
    expect(parsed.port).toBe(3001);

    console.log(`  ✓ projectId stable: ${run1.projectId} === ${run2.projectId}`);
    console.log(`  ✓ sessionPrefix stable: ${run1.projectConfig.sessionPrefix}`);
    console.log(`  ✓ path stable: ${run1.projectConfig.path}`);
    console.log(`  ✓ No duplication: ${projectKeys.length} project(s)`);
    console.log(`  ✓ port preserved: ${parsed.port}`);
    console.log(`  ✓ Zod loadConfig: PASS`);
  });

  // =========================================================================
  // BONUS: path normalization consistency
  // =========================================================================
  it("Case 3b: path is normalized regardless of input format", () => {
    // Same repo, different path representations
    const fromForwardSlash = generateConfigFromPath("C:/Users/hkmen/trading-system");
    const fromResolved = generateConfigFromPath(resolve(TRADING_SYSTEM));

    expect(fromForwardSlash.projectId).toBe(fromResolved.projectId);
    expect(fromForwardSlash.projectConfig.path).toBe(fromResolved.projectConfig.path);
    expect(fromForwardSlash.projectConfig.sessionPrefix).toBe(fromResolved.projectConfig.sessionPrefix);

    console.log(`  ✓ Forward slash path: ${fromForwardSlash.projectConfig.path}`);
    console.log(`  ✓ Resolved path:      ${fromResolved.projectConfig.path}`);
    console.log(`  ✓ Identical: true`);
  });
});
