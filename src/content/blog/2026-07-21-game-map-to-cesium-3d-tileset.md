---
author: StevenPG
pubDatetime: 2026-07-21T12:00:00.000Z
title: How I Turned a Game Map into a 3D Cesium Tileset
slug: game-map-to-cesium-3d-tileset
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - cesium
  - javascript
  - gis
description: The making of the Elden Ring 3D Map — turning a game world's heightmap and map imagery into streamable terrain and imagery tiles that CesiumJS can render, plus 170+ annotated points of interest.
---

# How I Turned a Game Map into a 3D Cesium Tileset

## Table of Contents

[[toc]]

## Brief

My goal is to make posts like this the SIMPLEST place on the internet to learn how to do things that caused me trouble. This is the making-of post for the [Elden Ring 3D Map](/projects/elden-ring-3d-map/) — an interactive 3D map of the Lands Between that renders the game's overworld as navigable terrain in the browser, with 170+ annotated Sites of Grace.

Searches like "cesium 3d tiles from heightmap" are full of people asking how to get _non-Earth_ data into CesiumJS — game worlds, fantasy maps, Mars, whatever — and getting answers that assume you have georeferenced satellite data. You don't need it. This post walks the whole pipeline: two source images → tiled terrain and imagery → a CesiumJS viewer that treats a fantasy continent like a planet.

## What You Actually Need

Cesium renders two independent streams that combine into "terrain you can fly around":

1. **A terrain provider** — elevation data, streamed as tiles at increasing detail.
2. **An imagery provider** — the pretty pixels, draped over the terrain, also tiled.

Which means the entire input for a game-world map is:

- **A heightmap**: one grayscale image where brightness = elevation
- **The map imagery**: one large color image of the world, top-down

Everything else is transformation. If you can produce those two images for _any_ world — from game files, from community mapping projects, or by stitching in-game screenshots — the rest of this pipeline applies unchanged.

## The Core Trick: Lie About the Coordinates

Cesium wants geographic coordinates; a game world doesn't have any. The move is to simply **pick a patch of the real globe and pretend your world lives there**. Choose a rectangle — degrees of longitude/latitude sized to keep the world's proportions roughly right (a degree of latitude ≈ 111km, and longitude shrinks by cos(latitude), so straddling the equator keeps the math friendly) — and georeference both images to that rectangle.

That's it. That's the insight the "how do I make a fake globe" threads are missing. Once your PNG claims to be that patch of Earth, every geospatial tool in existence works on it.

With GDAL, the lie is one command per image:

```bash
# Assign a coordinate rectangle to the raw heightmap
gdal_translate -of GTiff \
  -a_srs EPSG:4326 \
  -a_ullr -2.0 2.0 2.0 -2.0 \
  heightmap.png heightmap-geo.tif

# Same rectangle for the imagery so they line up perfectly
gdal_translate -of GTiff \
  -a_srs EPSG:4326 \
  -a_ullr -2.0 2.0 2.0 -2.0 \
  map-imagery.png imagery-geo.tif
```

`-a_ullr` is "upper-left / lower-right" — here a 4°×4° world centered on null island, which nobody's real map is using anyway.

## Terrain: Heightmap → Quantized Mesh

The heightmap's gray values need to become real elevations. `gdal_calc` rescales 0–255 into a meters range that feels right for the world (this is an artistic decision — I tuned the vertical scale until cliffs looked like the game's cliffs rather than gentle hills):

```bash
gdal_calc.py -A heightmap-geo.tif \
  --calc="A*(MAX_ELEV/255.0)" \
  --outfile=elevation.tif --type=Float32
```

Then [Cesium Terrain Builder][ctb] (the maintained `ctb-quantized-mesh` docker image) slices it into the **quantized-mesh** tile pyramid Cesium streams:

```bash
docker run -v $(pwd):/data tumgis/ctb-quantized-mesh \
  ctb-tile -f Mesh -C -o /data/terrain /data/elevation.tif
docker run -v $(pwd):/data tumgis/ctb-quantized-mesh \
  ctb-tile -f Mesh -C -l -o /data/terrain /data/elevation.tif   # layer.json
```

Out comes a `terrain/` directory of `.terrain` tiles plus `layer.json` — a static file tree you can serve from any web server or CDN. No tile server process, no database. (A note on vocabulary, because search results conflate them: "3D Tiles" usually refers to the format for _models_ — buildings, photogrammetry, point clouds. Streamed _terrain_ uses quantized-mesh. For a world made of elevation + imagery, quantized-mesh is the right pipeline, and it's much cheaper to produce.)

## Imagery: One Big Image → Tile Pyramid

Same idea, standard tooling — `gdal2tiles` produces slippy-map tiles:

```bash
gdal2tiles.py --profile=geodetic --zoom=0-14 --webviewer=none \
  imagery-geo.tif tiles/
```

The zoom ceiling is set by your source resolution: each zoom level doubles pixel density, and past your native resolution you're just serving blur. Fourteen levels over a 4° rectangle already means sub-meter texel density for a world image in the tens-of-thousands-of-pixels range.

## The Cesium Viewer

Wiring both pyramids into CesiumJS:

```javascript
const viewer = new Cesium.Viewer("cesiumContainer", {
  terrainProvider: await Cesium.CesiumTerrainProvider.fromUrl("/terrain"),
  baseLayer: new Cesium.ImageryLayer(
    new Cesium.TileMapServiceImageryProvider({
      url: "/tiles",
      rectangle: Cesium.Rectangle.fromDegrees(-2.0, -2.0, 2.0, 2.0),
    })
  ),
  baseLayerPicker: false,
  geocoder: false, // searching Earth addresses on a fantasy map: no
  sceneModePicker: false,
  timeline: false,
  animation: false,
});

// Don't let users fly off to an empty blue sphere
viewer.scene.globe.showGroundAtmosphere = false;
viewer.camera.flyTo({
  destination: Cesium.Rectangle.fromDegrees(-2.0, -2.0, 2.0, 2.0),
});
```

Stripping the Earth-specific widgets matters for the illusion — and if you've read [Stop Reinventing the Cesium Timeline](/posts/stop-reinventing-cesium-timeline), you know my feelings about which Cesium widgets deserve your loyalty anyway.

## 170+ Sites of Grace: Just GeoJSON

Once the world has coordinates, points of interest are ordinary geospatial data. Every Site of Grace is a feature in a GeoJSON file — converting from map-pixel positions to "coordinates" is the same linear mapping as the georeferencing rectangle:

```javascript
const graceSites = await Cesium.GeoJsonDataSource.load(
  "/data/sites-of-grace.geojson",
  {
    clampToGround: true,
  }
);
viewer.dataSources.add(graceSites);

for (const entity of graceSites.entities.values) {
  entity.billboard = new Cesium.BillboardGraphics({
    image: "/icons/grace.png",
    heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
    scaleByDistance: new Cesium.NearFarScalar(1e3, 1.0, 5e5, 0.4),
  });
}
```

`clampToGround` pins markers to the streamed terrain surface, and `scaleByDistance` keeps 170 billboards from becoming soup when zoomed out. Names and descriptions ride along as GeoJSON properties and appear in Cesium's info box for free.

## Lessons Learned

- **The illusion breaks at the edges.** A finite world on an infinite globe means visible seams where your rectangle ends. Constraining the camera (and disabling atmosphere) hides most of it; a subtle fog color match hides the rest.
- **Terrain exaggeration is a feature.** `viewer.scene.verticalExaggeration` lets you tune drama at runtime instead of re-baking elevation tiles.
- **Static tiles are a superpower.** The entire "backend" is a directory of files — the map costs almost nothing to host and scales with the CDN.
- **Do the georeferencing once, early.** Every downstream artifact — terrain, imagery, POI coordinates — depends on that rectangle. Changing it later means redoing everything.

## Summary

Turning a game world into a browsable 3D map is: pick a fake coordinate rectangle, georeference a heightmap and an imagery image to it with GDAL, bake quantized-mesh terrain with Cesium Terrain Builder and imagery tiles with gdal2tiles, and point a de-Earthed CesiumJS viewer at the results. POIs are plain GeoJSON from then on. None of it requires a GIS background — just the one conceptual trick of lying about where your world is.

Explore the result at the [Elden Ring 3D Map](/projects/elden-ring-3d-map/) project page, and the rest of my Cesium posts are cross-linked there via the project's related tag.

[ctb]: https://github.com/geo-data/cesium-terrain-builder
[cesium-terrain]: https://cesium.com/learn/cesiumjs/ref-doc/CesiumTerrainProvider.html
[gdal]: https://gdal.org/
