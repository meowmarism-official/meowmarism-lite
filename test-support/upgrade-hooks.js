// Replaces the network steps of an upgrade: no version lists, downloads or Java installs.
// A ".hold" file in the instance folder keeps the "download" running until the test removes it.
const fs = require('fs');
const path = require('path');

module.exports = {
  listLoaderVersions: async (loader, mcVersion) => (mcVersion === '9.9.9' ? [] : ['1']),
  ensureJava: async () => null,
  installServerSoftware: async (loader, mcVersion, loaderVersion, ramMB, dir) => {
    while (fs.existsSync(path.join(dir, '.hold'))) await new Promise((resolve) => setTimeout(resolve, 100));
    // The launch file is written first, so a failure below leaves a half-installed folder like a download that dies midway.
    fs.writeFileSync(path.join(dir, 'run.sh'), `#!/bin/sh\n# version ${mcVersion}\nexit 0\n`, { mode: 0o755 });
    if (mcVersion === '1.99.0') throw new Error('download failed');
    fs.writeFileSync(path.join(dir, 'server.jar'), `jar ${mcVersion}`);
  },
};
