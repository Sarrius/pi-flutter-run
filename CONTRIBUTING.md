# Contributing to pi-flutter-run

Thanks for helping improve `pi-flutter-run`.

## Ways to contribute

- Report bugs with reproduction steps, Flutter/Pi versions, OS, and logs.
- Propose features or UX improvements for the debug cockpit.
- Improve docs, examples, launch configuration support, or platform compatibility.
- Submit pull requests with focused, reviewable changes.

## Development setup

```bash
git clone https://github.com/Sarrius/pi-flutter-run.git
cd pi-flutter-run
npm install
npm run check
npm run pack:check
```

For local Pi testing, install the package from a local path:

```bash
pi install ./path/to/pi-flutter-run
```

Then restart Pi or run `/reload`, open a Flutter project, and run:

```text
/flutter-run
```

## Pull request process

1. Open an issue first for non-trivial changes so the direction can be discussed.
2. Keep PRs small and focused: one bugfix or feature per PR.
3. Add or update README/docs when behavior changes.
4. Run `npm run check` and `npm run pack:check` before opening the PR.
5. Describe manual validation: OS, Flutter version, Pi version, device/simulator, and launch config used.

## Code style

- TypeScript, ESM modules, strict type checking.
- Keep Pi core packages as peer dependencies.
- Avoid hidden telemetry or network calls unless explicitly documented and user-controlled.
- Prefer portable behavior across macOS, Linux, and Windows where possible.
- Do not commit secrets, local `.npmrc`, build artifacts, or `node_modules`.

## Release process

Maintainers publish releases to npm:

```bash
npm version patch
npm publish --access public
```

The public install command is:

```bash
pi install npm:pi-flutter-run
```
