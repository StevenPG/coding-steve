---
title: Cesium Spatial
description: A pair of TypeScript libraries that put H3 hexagons and S2 quadrilaterals on a CesiumJS globe, with a live demo for exploring both grid systems interactively.
url: https://stevenpg.github.io/cesium-spatial/demo.html
image: /assets/projects/cesium-spatial.jpg
tags:
  - Library
  - 3D
  - GIS
featured: true
order: 6
relatedTag: cesium
---

A pair of TypeScript libraries that put H3 hexagons and S2 quadrilaterals on a CesiumJS globe, without having to learn H3 or S2 first. Cover whatever the camera is looking at, draw thousands of cells as a single batched primitive, and walk neighbors, parents and children in Cesium's own vocabulary — longitude before latitude, degrees in, Cesium types out.

There are three packages. [`@stevenpg/cesium-h3`](https://www.npmjs.com/package/@stevenpg/cesium-h3) covers the H3 hexagonal grid, [`@stevenpg/cesium-s2`](https://www.npmjs.com/package/@stevenpg/cesium-s2) covers the S2 quadrilateral grid, and `@stevenpg/cesium-spatial-core` holds the shared rendering, picking, camera and level-of-detail machinery. Install whichever grid you need and core arrives as its dependency.

The two grid packages deliberately keep their own vocabulary. H3 speaks of resolutions, disks and rings; S2 of levels, tokens and cube faces. Each reads naturally to someone who already knows that index.

The [live demo](https://stevenpg.github.io/cesium-spatial/demo.html) is the fastest way to get a feel for either grid: switch between H3's 16 resolutions and S2's 31 levels, set a cell budget, clamp to terrain, extrude cells into prisms, and click any cell to inspect it. Full [API reference](https://stevenpg.github.io/cesium-spatial/api/) and source on [GitHub](https://github.com/StevenPG/cesium-spatial).
