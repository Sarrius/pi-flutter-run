# pi-flutter-run

Flutter run, hot reload, logs, and Dart VM debug cockpit for [Pi Agent](https://pi.dev/).

`pi-flutter-run` is a Pi extension for Flutter developers who want to keep Flutter runtime feedback inside their agent workflow instead of switching between terminal, IDE, logs, and chat.

## Install

```bash
pi install npm:pi-flutter-run
```

Restart Pi or run `/reload` after installation if the current session does not pick up the new package automatically.

## Usage

Run this command inside a Flutter project that has `.vscode/launch.json` Dart/Flutter launch configurations:

```text
/flutter-run
```

The extension opens an interactive Flutter debug cockpit where you can choose a launch config, keep the Flutter process running, inspect logs, hot reload/restart, and send debug context back to the agent.

## Features

- `/flutter-run` command for selecting Flutter launch configs and starting `flutter run`.
- Interactive debug overlay/cockpit with retained Flutter output.
- Hot reload and hot restart controls.
- Latest error/log extraction for fast agent debugging.
- Dart VM Service connection for pause/resume/step/breakpoint-oriented debug workflows.
- Agent-callable tools:
  - `flutter_debug_state()`
  - `flutter_debug_logs(maxLines?)`
  - `flutter_debug_latest_error()`
  - `flutter_debug_hot_reload()`
  - `flutter_debug_hot_restart()`
  - `flutter_debug_stop()`

## Requirements

- Pi Agent with extension package support.
- Flutter SDK available on `PATH`.
- A Flutter project with `.vscode/launch.json` configurations using Dart/Flutter launch entries.
- Node.js supported by the installed Pi Agent version.

## Example `.vscode/launch.json`

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Flutter debug",
      "request": "launch",
      "type": "dart",
      "program": "lib/main.dart",
      "flutterMode": "debug"
    }
  ]
}
```

## Public discovery

This package is tagged with the `pi-package` npm keyword so Pi package search/gallery tooling can discover it. It is published as a public npm package and can also be inspected on GitHub:

- npm: https://www.npmjs.com/package/pi-flutter-run
- repository: https://github.com/Sarrius/pi-flutter-run

## Development

```bash
npm install
npm run check
npm run pack:check
```

Pi loads the TypeScript extension directly through the package manifest:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

## License

MIT
