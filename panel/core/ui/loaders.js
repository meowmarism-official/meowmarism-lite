// Small line icons for the server types. They are drawn for meowmarism, they are not the logos of the projects.
(function () {
  var TYPES = {
    vanilla: { label: 'Vanilla', color: '#7cb85a', body: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>' },
    fabric: { label: 'Fabric', color: '#dbb69b', body: '<path d="M4 7h16M4 12h16M4 17h16"/><path d="M7 4v16M12 4v16M17 4v16"/>' },
    forge: { label: 'Forge', color: '#8fa3d6', body: '<path d="M3 7h15c0 3-2 4-4 4l.7 3H17v3H7v-3h2.3L10 11C6 11 3 10 3 7z"/>' },
    neoforge: { label: 'NeoForge', color: '#e68c3a', body: '<path d="M3 8h13c0 3-2 4-4 4l.7 3H15v3H6v-3h2.3L9 12C5.5 12 3 11 3 8z"/><path d="M19 3v5M16.5 5.5h5"/>' },
    paper: { label: 'Paper', color: '#cfd6e4', body: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/><path d="M10 12h5M10 16h5"/>' },
    purpur: { label: 'Purpur', color: '#b678ea', body: '<path d="M6 4h12l3 5-9 11L3 9z"/><path d="M3 9h18M9 4l3 16M15 4l-3 16"/>' },
  };
  function info(loader) {
    var key = String(loader || 'vanilla').toLowerCase();
    return TYPES[key] || { label: key.charAt(0).toUpperCase() + key.slice(1), color: '#9299a3', body: TYPES.vanilla.body };
  }
  function svg(loader, size) {
    var t = info(loader);
    var px = size || 24;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' + px + '" height="' + px + '" fill="none" stroke="' + t.color + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + t.body + '</svg>';
  }
  window.MeowLoaders = { info: info, svg: svg, types: Object.keys(TYPES) };
})();
