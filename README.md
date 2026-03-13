# [sourdough](https://sourdough.github.io/) starter 🥖
www starter 🦕

- no toolchain required — just git and a browser
- demo https://sourdough.github.io/starter/www/
- source https://github.com/sourdough/starter

A working starting point for frontend and middleware development, demonstrating native modern browser APIs with minimal complexity. Adapt and iterate for your specific project, team, and audience.

## audience
Frontend and middleware developers, system architects, and designers working on accessible, international projects.

## goals
- working starting point using widely supported native browser technologies
- demonstrate KISS and YAGNI in practice: OO in DOM context, functional
  state management, selective encapsulation with and without shadow DOM
- reduce requirements to git and a browser
- augment with [Lit](https://lit.dev) and [Deno](https://docs.deno.com/) optional for any server needs, tools
  for specific, well-defined problems
- limit scope for maintainability; expand through lightweight self-apparent process

## browser support
- 1st tier: current Chrome, Safari, Edge, Deno
- 2nd tier: previous point release of the above (at most one month), Firefox
- Others: case-by-case with clear rationale

## includes
- [args.js](https://github.com/sourdough/starter/blob/main/tools/args.js) —
  minimal CLI argument parser; typed coercion (string, number, boolean),
  boolean flags, positionals via `--` sentinel, symbol keys for meta-flags
  (help, config) to prevent collision, predefined-property-only to prevent
  injection; no dependencies
- [external-importer.js](https://github.com/sourdough/starter/blob/main/tools/external-importer.js) —
  fetches ES module dependencies from CDN URLs, sanitizes content (strips bidi
  override/trojan-source characters, zero-width chars, control chars, normalizes
  whitespace and indentation), rewrites bare import specifiers to local relative
  paths, and saves versioned static copies — no npm, no node, no build toolchain
  on the consuming side. Dry-run by default; `--write` to execute. Includes
  `--outdated` to check pinned versions against CDN latest, and `--versions` for
  a summary of what's pinned.
- [http.js](https://github.com/sourdough/starter/blob/main/tools/http.js) Deno-based local dev HTTP server built on Hono; configurable host, port, and web root via CLI args; SPA fallback (serves index on extensionless routes); request logging with timing; configurable cache-control headers; graceful shutdown on SIGINT/SIGHUP
- `tools/kit.sh` — available scripts

