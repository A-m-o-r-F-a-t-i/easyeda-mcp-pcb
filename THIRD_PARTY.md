# Third-party dependencies

Production dependencies are pinned in package-lock.json. Their original licenses are retained in the installed dependency directories.

| Package | Use | License |
| --- | --- | --- |
| @modelcontextprotocol/sdk | MCP transport and schemas | MIT |
| zod | Typed input validation | MIT |
| polygon-clipping 0.15.7 | Boolean operations on copper polygons and holes | MIT |

The removed legacy portable SHA-256 factory is no longer shipped. Request deduplication uses Node.js built-in crypto. No third-party source has been copied without its package license; inspect the lockfile for transitive dependencies.
