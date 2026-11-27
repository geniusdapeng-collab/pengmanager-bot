# Workbench setup

The web workbench uses the configured owner sign-in. The local Agent may also be invoked from a Node 24 shell. Run the config helper to inspect the command and absolute runtime path for an authorized workstation.

```sh
node scripts/ai-workbench.mjs config --client generic
node scripts/agent.mjs guide
node scripts/agent.mjs list
```

If selecting a model environment file, use its absolute path outside the repository. Limit the file and its directory to the authorized local user. The config helper only reports the path and argument order. The stdio MCP process may offer the guide, available capabilities, planning and preflight. Use the shell for full native production.
