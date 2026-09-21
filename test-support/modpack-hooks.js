// Stands in for Modrinth: two fake modpacks (one NeoForge, one Quilt) and local .mrpack fixtures instead of downloads.
const fs = require('fs');
const path = require('path');

const PACKS = [
  { id: 'p1', slug: 'test-pack', title: 'Test Pack', description: 'A small NeoForge pack', icon: '', author: 'a', downloads: 1234, follows: 1, categories: ['neoforge'], mcVersions: ['1.21.1'] },
  { id: 'pq', slug: 'quilt-pack', title: 'Quilt Pack', description: 'Needs Quilt', icon: '', author: 'b', downloads: 99, follows: 1, categories: ['quilt'], mcVersions: ['1.21.1'] },
];
const VERSIONS = {
  p1: [{ id: 'v1', projectId: 'p1', versionNumber: '1.0', mcVersions: ['1.21.1'], loaders: ['neoforge'] }],
  pq: [{ id: 'vq', projectId: 'pq', versionNumber: '1.0', mcVersions: ['1.21.1'], loaders: ['quilt'] }],
};

module.exports = {
  listLoaderVersions: async (loader, mc) => (mc ? ['1'] : { mcVersions: ['1.21.1', '1.20.1'] }),
  modpackApi: {
    searchModpacks: async ({ query = '' } = {}) => {
      const hits = PACKS.filter((p) => p.title.toLowerCase().includes(String(query).toLowerCase()));
      return { total: hits.length, hits };
    },
    getVersions: async (id) => VERSIONS[id] || [],
    getVersion: async (id) => ({
      id, projectId: id === 'vq' ? 'pq' : 'p1', versionNumber: '1.0',
      file: { url: `https://cdn.modrinth.com/data/x/${id}.mrpack`, filename: `${id}.mrpack`, size: 1, sha512: 'x' },
    }),
  },
  modpackDownload: async (url, dest) => {
    fs.copyFileSync(path.join(__dirname, url.includes('vq') ? 'fixture-quilt.mrpack' : 'fixture.mrpack'), dest);
  },
};
