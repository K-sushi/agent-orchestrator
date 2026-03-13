/**
 * Unit tests for config-generator — URL parsing, SCM detection, config generation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRepoUrl,
  parseRepoUrl,
  detectScmPlatform,
  detectDefaultBranchFromDir,
  detectProjectInfo,
  generateConfigFromUrl,
  generateConfigFromPath,
  configToYaml,
  isRepoAlreadyCloned,
  resolveCloneTarget,
  sanitizeProjectId,
} from "../config-generator.js";
import { addProjectToConfig } from "../config.js";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// =============================================================================
// isRepoUrl
// =============================================================================

describe("isRepoUrl", () => {
  it("recognizes HTTPS URLs", () => {
    expect(isRepoUrl("https://github.com/owner/repo")).toBe(true);
    expect(isRepoUrl("http://github.com/owner/repo")).toBe(true);
    expect(isRepoUrl("https://gitlab.com/owner/repo.git")).toBe(true);
  });

  it("recognizes SSH URLs", () => {
    expect(isRepoUrl("git@github.com:owner/repo.git")).toBe(true);
    expect(isRepoUrl("git@gitlab.com:owner/repo")).toBe(true);
  });

  it("rejects non-URLs", () => {
    expect(isRepoUrl("my-project")).toBe(false);
    expect(isRepoUrl("")).toBe(false);
    expect(isRepoUrl("owner/repo")).toBe(false);
  });
});

// =============================================================================
// parseRepoUrl
// =============================================================================

describe("parseRepoUrl", () => {
  it("parses HTTPS GitHub URL", () => {
    const result = parseRepoUrl("https://github.com/ComposioHQ/DevOS");
    expect(result).toEqual({
      ownerRepo: "ComposioHQ/DevOS",
      owner: "ComposioHQ",
      repo: "DevOS",
      host: "github.com",
      cloneUrl: "https://github.com/ComposioHQ/DevOS.git",
    });
  });

  it("parses HTTPS URL with .git suffix", () => {
    const result = parseRepoUrl("https://github.com/ComposioHQ/DevOS.git");
    expect(result.ownerRepo).toBe("ComposioHQ/DevOS");
    expect(result.repo).toBe("DevOS");
  });

  it("parses HTTPS URL with trailing slash", () => {
    const result = parseRepoUrl("https://github.com/owner/repo/");
    expect(result.ownerRepo).toBe("owner/repo");
  });

  it("parses SSH URL", () => {
    const result = parseRepoUrl("git@github.com:ComposioHQ/DevOS.git");
    expect(result).toEqual({
      ownerRepo: "ComposioHQ/DevOS",
      owner: "ComposioHQ",
      repo: "DevOS",
      host: "github.com",
      cloneUrl: "https://github.com/ComposioHQ/DevOS.git",
    });
  });

  it("parses GitLab URL", () => {
    const result = parseRepoUrl("https://gitlab.com/my-org/my-project");
    expect(result.host).toBe("gitlab.com");
    expect(result.ownerRepo).toBe("my-org/my-project");
  });

  it("parses Bitbucket URL", () => {
    const result = parseRepoUrl("https://bitbucket.org/team/repo");
    expect(result.host).toBe("bitbucket.org");
    expect(result.ownerRepo).toBe("team/repo");
  });

  it("throws on invalid URL", () => {
    expect(() => parseRepoUrl("not-a-url")).toThrow("Could not parse repo URL");
    expect(() => parseRepoUrl("https://github.com/just-owner")).toThrow(
      "Could not parse repo URL",
    );
  });
});

// =============================================================================
// detectScmPlatform
// =============================================================================

describe("detectScmPlatform", () => {
  it("detects GitHub", () => {
    expect(detectScmPlatform("github.com")).toBe("github");
  });

  it("detects GitLab", () => {
    expect(detectScmPlatform("gitlab.com")).toBe("gitlab");
  });

  it("detects Bitbucket", () => {
    expect(detectScmPlatform("bitbucket.org")).toBe("bitbucket");
  });

  it("returns unknown for custom hosts", () => {
    expect(detectScmPlatform("git.mycompany.com")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(detectScmPlatform("GitHub.com")).toBe("github");
    expect(detectScmPlatform("GITLAB.COM")).toBe("gitlab");
  });
});

// =============================================================================
// detectDefaultBranchFromDir
// =============================================================================

describe("detectDefaultBranchFromDir", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-gen-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 'main' when no .git directory exists", () => {
    expect(detectDefaultBranchFromDir(tmpDir)).toBe("main");
  });

  it("detects branch from HEAD file", () => {
    mkdirSync(join(tmpDir, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/develop\n");
    writeFileSync(join(tmpDir, ".git", "refs", "remotes", "origin", "develop"), "abc123\n");
    // No common default branch refs exist, so falls back to current branch
    expect(detectDefaultBranchFromDir(tmpDir)).toBe("develop");
  });

  it("prefers common default branch over current branch", () => {
    mkdirSync(join(tmpDir, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/feature/foo\n");
    writeFileSync(join(tmpDir, ".git", "refs", "remotes", "origin", "main"), "abc123\n");
    expect(detectDefaultBranchFromDir(tmpDir)).toBe("main");
  });
});

// =============================================================================
// detectProjectInfo
// =============================================================================

describe("detectProjectInfo", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proj-detect-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects TypeScript + pnpm", () => {
    writeFileSync(join(tmpDir, "package.json"), "{}");
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "");
    const info = detectProjectInfo(tmpDir);
    expect(info.language).toBe("typescript");
    expect(info.packageManager).toBe("pnpm");
  });

  it("detects JavaScript + npm", () => {
    writeFileSync(join(tmpDir, "package.json"), "{}");
    writeFileSync(join(tmpDir, "package-lock.json"), "{}");
    const info = detectProjectInfo(tmpDir);
    expect(info.language).toBe("javascript");
    expect(info.packageManager).toBe("npm");
  });

  it("detects Rust", () => {
    writeFileSync(join(tmpDir, "Cargo.toml"), "");
    const info = detectProjectInfo(tmpDir);
    expect(info.language).toBe("rust");
    expect(info.packageManager).toBe("cargo");
  });

  it("detects Go", () => {
    writeFileSync(join(tmpDir, "go.mod"), "");
    const info = detectProjectInfo(tmpDir);
    expect(info.language).toBe("go");
    expect(info.packageManager).toBe("go");
  });

  it("detects Python", () => {
    writeFileSync(join(tmpDir, "pyproject.toml"), "");
    const info = detectProjectInfo(tmpDir);
    expect(info.language).toBe("python");
    expect(info.packageManager).toBe("pip");
  });

  it("returns null for unknown projects", () => {
    const info = detectProjectInfo(tmpDir);
    expect(info.language).toBeNull();
    expect(info.packageManager).toBeNull();
  });
});

// =============================================================================
// generateConfigFromUrl
// =============================================================================

describe("generateConfigFromUrl", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gen-config-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates valid config for GitHub repo", () => {
    // Set up minimal repo structure
    mkdirSync(join(tmpDir, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(tmpDir, ".git", "refs", "remotes", "origin", "main"), "abc\n");
    writeFileSync(join(tmpDir, "package.json"), "{}");
    writeFileSync(join(tmpDir, "tsconfig.json"), "{}");
    writeFileSync(join(tmpDir, "pnpm-lock.yaml"), "");

    const parsed = parseRepoUrl("https://github.com/ComposioHQ/DevOS");
    const config = generateConfigFromUrl({ parsed, repoPath: tmpDir });

    // Check top-level structure
    expect(config.port).toBe(3000);
    expect(config.defaults).toEqual({
      runtime: "tmux",
      agent: "claude-code",
      workspace: "worktree",
      notifiers: ["desktop"],
    });

    // Check project config
    const projects = config.projects as Record<string, Record<string, unknown>>;
    expect(projects.devos).toBeDefined();

    const project = projects.devos;
    expect(project.name).toBe("DevOS");
    expect(project.repo).toBe("ComposioHQ/DevOS");
    expect(project.path).toBe(tmpDir);
    expect(project.defaultBranch).toBe("main");
    expect(project.scm).toEqual({ plugin: "github" });
    expect(project.tracker).toEqual({ plugin: "github" });
    expect(project.postCreate).toEqual(["pnpm install"]);
  });

  it("generates config for GitLab repo", () => {
    const parsed = parseRepoUrl("https://gitlab.com/my-org/my-project");
    const config = generateConfigFromUrl({ parsed, repoPath: tmpDir });

    const projects = config.projects as Record<string, Record<string, unknown>>;
    const project = projects["my-project"];
    expect(project.scm).toEqual({ plugin: "gitlab" });
    expect(project.tracker).toEqual({ plugin: "gitlab" });
  });

  it("falls back to github for unknown hosts", () => {
    const parsed = parseRepoUrl("https://git.mycompany.com/team/app");
    const config = generateConfigFromUrl({ parsed, repoPath: tmpDir });

    const projects = config.projects as Record<string, Record<string, unknown>>;
    const project = projects.app;
    // Unknown hosts fall back to github (best available plugin)
    expect(project.scm).toEqual({ plugin: "github" });
    expect(project.tracker).toEqual({ plugin: "github" });
  });

  it("sets bitbucket SCM and github tracker for Bitbucket repos", () => {
    const parsed = parseRepoUrl("https://bitbucket.org/team/app");
    const config = generateConfigFromUrl({ parsed, repoPath: tmpDir });

    const projects = config.projects as Record<string, Record<string, unknown>>;
    const project = projects.app;
    expect(project.scm).toEqual({ plugin: "bitbucket" });
    // Bitbucket tracker not implemented, falls back to github
    expect(project.tracker).toEqual({ plugin: "github" });
  });

  it("does not set postCreate for non-JS projects", () => {
    writeFileSync(join(tmpDir, "Cargo.toml"), "");
    const parsed = parseRepoUrl("https://github.com/owner/rust-app");
    const config = generateConfigFromUrl({ parsed, repoPath: tmpDir });

    const projects = config.projects as Record<string, Record<string, unknown>>;
    const project = projects["rust-app"];
    expect(project.postCreate).toBeUndefined();
  });

  it("sets postCreate for JS projects with npm", () => {
    writeFileSync(join(tmpDir, "package.json"), "{}");
    writeFileSync(join(tmpDir, "package-lock.json"), "{}");
    const parsed = parseRepoUrl("https://github.com/owner/js-app");
    const config = generateConfigFromUrl({ parsed, repoPath: tmpDir });

    const projects = config.projects as Record<string, Record<string, unknown>>;
    const project = projects["js-app"];
    expect(project.postCreate).toEqual(["npm install"]);
  });

  it("respects custom port", () => {
    const parsed = parseRepoUrl("https://github.com/owner/repo");
    const config = generateConfigFromUrl({ parsed, repoPath: tmpDir, port: 8080 });
    expect(config.port).toBe(8080);
  });

  it("preserves CamelCase for session prefix generation", () => {
    const parsed = parseRepoUrl("https://github.com/ComposioHQ/DevOS");
    const config = generateConfigFromUrl({ parsed, repoPath: tmpDir });

    const projects = config.projects as Record<string, Record<string, unknown>>;
    // projectId key should be lowercase
    expect(projects.devos).toBeDefined();
    // sessionPrefix should use CamelCase path: D, O, S → "dos"
    expect(projects.devos.sessionPrefix).toBe("dos");
  });

  it("produces valid session prefix for repo names with dots", () => {
    const parsed = parseRepoUrl("https://github.com/owner/my.app");
    const config = generateConfigFromUrl({ parsed, repoPath: tmpDir });

    const projects = config.projects as Record<string, Record<string, unknown>>;
    // projectId key: dot replaced with hyphen
    expect(projects["my-app"]).toBeDefined();
    // sessionPrefix: "my.app" → sanitized to "my-app" → kebab initials → "ma"
    const prefix = projects["my-app"].sessionPrefix as string;
    expect(prefix).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(prefix).toBe("ma");
  });
});

// =============================================================================
// sanitizeProjectId
// =============================================================================

describe("sanitizeProjectId", () => {
  it("lowercases the name", () => {
    expect(sanitizeProjectId("DevOS")).toBe("devos");
  });

  it("replaces dots with hyphens", () => {
    expect(sanitizeProjectId("my.app")).toBe("my-app");
  });

  it("replaces multiple special chars", () => {
    expect(sanitizeProjectId("My@Cool.App!")).toBe("my-cool-app");
  });

  it("collapses consecutive hyphens", () => {
    expect(sanitizeProjectId("my--app")).toBe("my-app");
  });

  it("strips leading/trailing hyphens", () => {
    expect(sanitizeProjectId("-my-app-")).toBe("my-app");
  });

  it("preserves valid characters", () => {
    expect(sanitizeProjectId("my-app_v2")).toBe("my-app_v2");
  });
});

// =============================================================================
// configToYaml
// =============================================================================

describe("configToYaml", () => {
  it("serializes config to valid YAML", () => {
    const config = { port: 3000, projects: { app: { name: "App" } } };
    const yaml = configToYaml(config);
    expect(yaml).toContain("port: 3000");
    expect(yaml).toContain("name: App");
  });
});

// =============================================================================
// isRepoAlreadyCloned
// =============================================================================

describe("isRepoAlreadyCloned", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "clone-check-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false for non-git directory", () => {
    expect(isRepoAlreadyCloned(tmpDir, "https://github.com/owner/repo.git")).toBe(false);
  });

  it("returns true when git config matches URL", () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/owner/repo.git\n`,
    );
    expect(isRepoAlreadyCloned(tmpDir, "https://github.com/owner/repo.git")).toBe(true);
  });

  it("normalizes URLs for comparison (strips .git)", () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/owner/repo\n`,
    );
    expect(isRepoAlreadyCloned(tmpDir, "https://github.com/owner/repo.git")).toBe(true);
  });

  it("matches SSH-cloned repo against HTTPS clone URL", () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:owner/repo.git\n`,
    );
    expect(isRepoAlreadyCloned(tmpDir, "https://github.com/owner/repo.git")).toBe(true);
  });

  it("matches HTTPS-cloned repo against SSH-derived clone URL", () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/owner/repo.git\n`,
    );
    // parseRepoUrl("git@github.com:owner/repo.git").cloneUrl produces HTTPS
    expect(isRepoAlreadyCloned(tmpDir, "https://github.com/owner/repo.git")).toBe(true);
  });

  it("returns false when URL doesn't match", () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/other/repo.git\n`,
    );
    expect(isRepoAlreadyCloned(tmpDir, "https://github.com/owner/repo.git")).toBe(false);
  });
});

// =============================================================================
// resolveCloneTarget
// =============================================================================

describe("resolveCloneTarget", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "resolve-target-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reuses CWD if it matches the repo", () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/owner/repo.git\n`,
    );
    const parsed = parseRepoUrl("https://github.com/owner/repo");
    expect(resolveCloneTarget(parsed, tmpDir)).toBe(tmpDir);
  });

  it("reuses CWD/repo-name if it matches", () => {
    const subDir = join(tmpDir, "repo");
    mkdirSync(join(subDir, ".git"), { recursive: true });
    writeFileSync(
      join(subDir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/owner/repo.git\n`,
    );
    const parsed = parseRepoUrl("https://github.com/owner/repo");
    expect(resolveCloneTarget(parsed, tmpDir)).toBe(subDir);
  });

  it("returns CWD/repo-name for fresh clone", () => {
    const parsed = parseRepoUrl("https://github.com/owner/my-app");
    const result = resolveCloneTarget(parsed, tmpDir);
    expect(result).toBe(join(tmpDir, "my-app"));
  });
});

// =============================================================================
// generateConfigFromPath (auto-onboard from local directory)
// =============================================================================

describe("generateConfigFromPath", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gen-from-path-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts ownerRepo from HTTPS origin URL in .git/config", () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/K-sushi/trading-system.git\n`,
    );
    mkdirSync(join(tmpDir, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(tmpDir, ".git", "refs", "remotes", "origin", "main"), "abc\n");

    const result = generateConfigFromPath(tmpDir);
    expect(result.projectId).toBe("trading-system");
    expect(result.projectConfig.repo).toBe("K-sushi/trading-system");
    expect(result.projectConfig.name).toBe("trading-system");
    expect(result.projectConfig.defaultBranch).toBe("main");
  });

  it("extracts ownerRepo from SSH origin URL", () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:ComposioHQ/agent-orchestrator.git\n`,
    );

    const result = generateConfigFromPath(tmpDir);
    expect(result.projectConfig.repo).toBe("ComposioHQ/agent-orchestrator");
    expect(result.projectId).toBe("agent-orchestrator");
  });

  it("detects .claude/ directory and adds to symlinks", () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/owner/repo.git\n`,
    );
    mkdirSync(join(tmpDir, ".claude"));

    const result = generateConfigFromPath(tmpDir);
    expect(result.projectConfig.symlinks).toEqual([".claude"]);
  });

  it("returns empty symlinks when no .claude/ exists", () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/owner/repo.git\n`,
    );

    const result = generateConfigFromPath(tmpDir);
    expect(result.projectConfig.symlinks).toEqual([]);
  });

  it("falls back to local/unknown when no origin remote", () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(join(tmpDir, ".git", "config"), "[core]\n\tbare = false\n");

    const result = generateConfigFromPath(tmpDir);
    expect(result.projectConfig.repo).toBe("local/unknown");
    expect(result.projectId).toBe("unknown");
  });

  it("generates valid sessionPrefix", () => {
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/owner/my-cool-app.git\n`,
    );

    const result = generateConfigFromPath(tmpDir);
    expect(result.projectConfig.sessionPrefix).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

// =============================================================================
// addProjectToConfig (write project entry to YAML file)
// =============================================================================

describe("addProjectToConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "add-project-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds a project to an existing YAML config", () => {
    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(
      configPath,
      "port: 3001\nprojects:\n  existing:\n    repo: org/existing\n    path: /tmp/existing\n",
    );

    addProjectToConfig(configPath, "new-project", {
      name: "new-project",
      repo: "org/new-project",
      path: "/tmp/new-project",
      defaultBranch: "main",
      sessionPrefix: "np",
      symlinks: [".claude"],
    });

    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const projects = parsed.projects as Record<string, Record<string, unknown>>;

    // Original project preserved
    expect(projects.existing).toBeDefined();
    expect(projects.existing.repo).toBe("org/existing");

    // New project added
    expect(projects["new-project"]).toBeDefined();
    expect(projects["new-project"].repo).toBe("org/new-project");
    expect(projects["new-project"].symlinks).toEqual([".claude"]);

    // Port preserved
    expect(parsed.port).toBe(3001);
  });

  it("creates projects section if missing", () => {
    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "port: 3000\n");

    addProjectToConfig(configPath, "my-app", {
      name: "my-app",
      repo: "owner/my-app",
      path: "/tmp/my-app",
    });

    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const projects = parsed.projects as Record<string, Record<string, unknown>>;
    expect(projects["my-app"].repo).toBe("owner/my-app");
  });

  it("creates file if it doesn't exist", () => {
    const configPath = join(tmpDir, "new-config.yaml");

    addProjectToConfig(configPath, "fresh", {
      name: "fresh",
      repo: "owner/fresh",
      path: "/tmp/fresh",
    });

    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const projects = parsed.projects as Record<string, Record<string, unknown>>;
    expect(projects.fresh.repo).toBe("owner/fresh");
  });

  it("end-to-end: generateConfigFromPath → addProjectToConfig round-trip", () => {
    // Create a mock git repo
    const repoDir = join(tmpDir, "my-repo");
    mkdirSync(join(repoDir, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(
      join(repoDir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/K-sushi/my-repo.git\n`,
    );
    writeFileSync(join(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(repoDir, ".git", "refs", "remotes", "origin", "main"), "abc\n");
    mkdirSync(join(repoDir, ".claude"));

    // Generate config from path
    const { projectId, projectConfig } = generateConfigFromPath(repoDir);

    // Write to config file
    const configPath = join(tmpDir, "agent-orchestrator.yaml");
    writeFileSync(configPath, "port: 3001\nprojects: {}\n");
    addProjectToConfig(configPath, projectId, projectConfig);

    // Verify round-trip
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    const projects = parsed.projects as Record<string, Record<string, unknown>>;

    expect(projects["my-repo"]).toBeDefined();
    expect(projects["my-repo"].repo).toBe("K-sushi/my-repo");
    expect(projects["my-repo"].defaultBranch).toBe("main");
    expect(projects["my-repo"].symlinks).toEqual([".claude"]);
    expect(projects["my-repo"].sessionPrefix).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});
