# External Contract: Local Command Execution

## Execution model

- The plugin backend launches a configured local executable from the workspace directory.
- The prompt is passed through a documented command-template mechanism rather than through host chat
  internals.

## Required configuration

- `command`: executable name or absolute path
- `args`: ordered argument template
- `timeoutMs`: maximum allowed execution time for one run

## Runtime guarantees

- The plugin records a run before launching the command.
- Standard output and standard error are captured for outcome summaries and debugging.
- A non-zero exit code marks the run as `failed`.
- A missing executable or launch error marks the run as `failed` with a configuration-oriented
  message.

## Security constraints

- The plugin stores command metadata but does not need hosted API secrets.
- The subprocess runs under the same local user context as the plugin host, so configuration must
  be explicit and visible to the user.
