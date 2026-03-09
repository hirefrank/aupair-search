const ua = process.env.npm_config_user_agent || "";

if (!ua.includes("bun/")) {
  console.error("This repository is Bun-only.");
  console.error("Use Bun commands instead of npm/yarn/pnpm.");
  console.error("Examples: bun install, bun run crawl, bun run analyze, bun run typecheck.");
  process.exit(1);
}
