#!/usr/bin/env node
/**
 * The release build's half of desktop.mjs: builds the web resource, then
 * stops — release.yml hands the actual `tauri build` to tauri-action, which
 * also signs (TAURI_SIGNING_PRIVATE_KEY) and uploads to the GitHub Release,
 * so it has to invoke `tauri build` itself rather than going through
 * `npm run tauri` the way local packaging does.
 *
 * Prints the `--bundles` value release.yml's tauri-action step needs, on its
 * own final line, so the workflow can capture it without hardcoding the
 * platform's format list a second time.
 */
import { prepareDesktopBuild } from './desktop.mjs';

const { bundleFormats } = prepareDesktopBuild();
process.stdout.write(`bundles=${bundleFormats.join(',')}\n`);
