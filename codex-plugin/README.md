# Code Buddy for Codex

This directory is a self-contained local Codex marketplace. It includes the
Code Buddy plugin, its lifecycle hooks, MCP server, tests, and marketplace
metadata.

## Install from a download or clone

1. Download or clone this repository.
2. In a terminal, add this directory as a local marketplace:

   ```bash
   codex plugin marketplace add /absolute/path/to/Token_Lens/codex-plugin
   ```

3. Install and enable Code Buddy:

   ```bash
   codex plugin add code-buddy@token-lens
   ```

4. Fully restart Codex, then create a new task. Review and trust the Code
   Buddy hook when Codex requests it.

The native **Plugins → Code Buddy → Enable/Disable** switch is persistent for
new tasks. When enabled and trusted, Code Buddy automatically performs its
preflight for meaningful coding requests. A fresh task created from accepted
curated context waits until the marked handoff is pasted or the developer
submits exactly `Code Buddy: continue without curated context`.

To update, download a newer repository version and run the two installation
commands again from the new local path.
