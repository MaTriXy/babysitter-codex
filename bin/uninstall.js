#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const shared = require('./install-shared');

const PACKAGE_ROOT = path.resolve(__dirname, '..');

function main() {
  const pluginRoot = shared.getHomePluginRoot();
  const codexHome = shared.getCodexHome();

  try {
    if (fs.existsSync(pluginRoot)) {
      fs.rmSync(pluginRoot, { recursive: true, force: true });
      console.log(`[${shared.PLUGIN_NAME}] Removed plugin bundle at ${pluginRoot}`);
    } else {
      console.log(`[${shared.PLUGIN_NAME}] Plugin not installed at ${pluginRoot}`);
    }
    shared.removeMarketplaceEntry(shared.getHomeMarketplacePath());
    shared.removeManagedCodexSurface(codexHome, PACKAGE_ROOT);
    console.log(`[${shared.PLUGIN_NAME}] Removed managed hooks and skills from ${codexHome}`);
  } catch (err) {
    console.error(`[${shared.PLUGIN_NAME}] Failed to uninstall: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
