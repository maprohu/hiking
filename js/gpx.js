'use strict';

// Hand-rolled GPX writer + download helper.
const GPX = (() => {
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function toGPX(name, latlngs) {
    const pts = latlngs.map(([lat, lng]) =>
      `      <trkpt lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"/>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Hike Route Planner" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${esc(name)}</name>
    <copyright author="OpenStreetMap contributors">
      <license>https://www.openstreetmap.org/copyright</license>
    </copyright>
  </metadata>
  <trk>
    <name>${esc(name)}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
  }

  function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/gpx+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  return { toGPX, download };
})();
