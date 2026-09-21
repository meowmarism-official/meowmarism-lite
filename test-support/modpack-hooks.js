// Stands in for Modrinth and the server-software install: fake packs, local .mrpack fixtures, no downloads.
// MEOW_TEST_FAIL: software | file | rename makes that step fail. A ".hold-create" file in HOME pauses the software install.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PACKS = [
  { id: 'p1', slug: 'test-pack', title: 'Test Pack', description: 'A small NeoForge pack', icon: '', author: 'a', downloads: 1234, follows: 1, categories: ['neoforge'], mcVersions: ['1.21.1'] },
  { id: 'pq', slug: 'quilt-pack', title: 'Quilt Pack', description: 'Needs Quilt', icon: '', author: 'b', downloads: 99, follows: 1, categories: ['quilt'], mcVersions: ['1.21.1'] },
];
const VERSIONS = {
  p1: [{ id: 'v1', projectId: 'p1', versionNumber: '1.0', mcVersions: ['1.21.1'], loaders: ['neoforge'] }],
  pq: [{ id: 'vq', projectId: 'pq', versionNumber: '1.0', mcVersions: ['1.21.1'], loaders: ['quilt'] }],
};
const FIXTURES = { v1: 'fixture.mrpack', vq: 'fixture-quilt.mrpack', vf: 'fixture-fabric.mrpack', vp: 'fixture-props.mrpack', vg: 'fixture-forge.mrpack', vu: 'fixture-forge-unknown.mrpack' };
const PROJECT_OF = { v1: 'p1', vq: 'pq', vf: 'pf', vp: 'pp', vg: 'pg', vu: 'pu' };
const fail = process.env.MEOW_TEST_FAIL;

module.exports = {
  listLoaderVersions: async (loader, mc) => (mc ? (loader === 'forge' ? ['47.4.0', '47.3.0'] : ['1']) : { mcVersions: ['1.21.1', '1.20.1'] }),
  ensureJava: async () => null,
  installServerSoftware: async (loader, mcVersion, loaderVersion, ramMB, dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\n# launcher made by the runtime\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, '.installed-with.json'), JSON.stringify({ loader, mcVersion, loaderVersion }));
    while (fs.existsSync(path.join(os.homedir(), '.hold-create'))) await new Promise((resolve) => setTimeout(resolve, 100));
    if (fail === 'software') throw new Error('server software download failed');
  },
  renameDir: (from, to) => {
    if (fail === 'rename') throw new Error('rename failed');
    fs.renameSync(from, to);
  },
  modpackApi: {
    searchModpacks: async ({ query = '' } = {}) => {
      const hits = PACKS.filter((p) => p.title.toLowerCase().includes(String(query).toLowerCase()));
      return { total: hits.length, hits };
    },
    getVersions: async (id) => VERSIONS[id] || [],
    getVersion: async (id) => ({
      id, projectId: PROJECT_OF[id] || 'p1', versionNumber: '1.0',
      file: { url: `https://cdn.modrinth.com/data/x/${id}.mrpack`, filename: `${id}.mrpack`, size: 1, sha512: 'x' },
    }),
  },
  modpackDownload: async (url, dest) => {
    const id = /\/([\w-]+)\.mrpack$/.exec(url)[1];
    fs.copyFileSync(path.join(__dirname, FIXTURES[id]), dest);
  },
  modpackFileDownload: async (url, dest) => {
    if (fail === 'file' && url.endsWith('/b.jar')) throw new Error('mod download failed');
    fs.writeFileSync(dest, 'jar');
  },
};
