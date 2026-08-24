---
author: StevenPG
pubDatetime: 2026-08-24T12:00:00.000Z
title: "H3 and S2 Cells on a Cesium Globe"
slug: cesium-h3-s2-grid-libraries
featured: false
ogImage: /assets/default-og-image.png
tags:
  - software
  - cesium
  - javascript
  - typescript
  - gis
description: I published two libraries that render H3 hexagons and S2 quadrilaterals on a CesiumJS globe, plus a demo that lets you play with both grid systems directly. Here's what's in them and what makes these grids interesting.
---

# H3 and S2 Cells on a Cesium Globe

## Table of Contents

[[toc]]

## Two New Libraries

I published a pair of TypeScript libraries this week:

- [`@stevenpg/cesium-h3`](https://www.npmjs.com/package/@stevenpg/cesium-h3) — the H3 hexagonal grid on a Cesium globe
- [`@stevenpg/cesium-s2`](https://www.npmjs.com/package/@stevenpg/cesium-s2) — the S2 quadrilateral grid on a Cesium globe

They share a third package, `@stevenpg/cesium-spatial-core`, which holds the rendering, picking, camera and level-of-detail machinery. You install whichever grid you want and core comes along as a dependency.

Before anything else, go [play with the demo](https://stevenpg.github.io/cesium-spatial/demo.html). That's the part I'm most pleased with, and I'll come back to why.

![The H3 grid at resolution zero over a Cesium globe, with the demo's resolution ladder alongside it](/assets/cesiumspatial/hero.jpg)

## The Whole Feature in One Object

Here's the shortest useful thing you can write:

```ts
import { Viewer } from "cesium";
import { H3ViewLayer } from "@stevenpg/cesium-h3";

const viewer = new Viewer("cesiumContainer");

// Watches the camera, picks a resolution, respects a cell budget.
new H3ViewLayer(viewer.scene, { maxCells: 8000, outlines: true });
```

That's it. You now have an H3 grid that follows the camera, chooses a sensible resolution for whatever you're looking at, and won't try to draw four million cells when you zoom out to see the whole planet.

The S2 version is the same shape:

```ts
import { S2ViewLayer } from "@stevenpg/cesium-s2";

new S2ViewLayer(viewer.scene, { maxCells: 8000, outlines: true });
```

Everything underneath the view layer is a plain function you can call directly. If you want to cover a rectangle, get a cell's boundary as Cesium positions, walk to its neighbors, or roll up a set of cells to their parents, those are all exports you can use without ever instantiating a layer.

## Why I Actually Built This

The honest answer is that I wanted H3 and S2 cells to be easy, and they weren't.

Both index systems are excellent. Both have good libraries in their own right. But the gap between "I have `h3-js` installed" and "there are hexagons on my globe that behave sensibly as I move the camera" is wider than it looks, and every Cesium project I've worked on has crossed that gap independently.

Some of that is Cesium-specific. Cesium has no zoom levels, so deciding which resolution to draw means measuring ground meters-per-pixel from the frustum rather than reading a number off the camera. Drawing thousands of cells means batching them into one primitive, which means recoloring has to write into per-instance attributes instead of rebuilding geometry, and picking has to map a geometry instance back to something your application recognizes.

None of that is hard, exactly. It's just a pile of small decisions that you have to make correctly before you get to the thing you actually sat down to do. This library is those decisions, made once.

## The Interesting Parts of These Grids

The part I enjoyed most was learning where H3 and S2 stop behaving the way you'd naively expect. These aren't flaws — they're consequences of how each grid is constructed, and they're genuinely neat once you see them.

### H3 reads a wide longitude span as an antimeridian crossing

H3 treats any polygon whose longitudes jump more than 180° as crossing the antimeridian. There's no flag to say otherwise, because from the polygon's coordinates alone there's no way to distinguish the two cases — the same four corners describe both the wide way around and the narrow way around.

The practical effect is that asking for the 200° around Greenwich quietly gives you the 160° around the dateline instead. You get a plausible cell count made of entirely the wrong cells, with no error. It's the kind of thing you only notice when you look at the globe.

### H3 has exactly twelve pentagons

You can't tile a sphere with hexagons alone. H3 is built on an icosahedron, and the twelve icosahedral vertices become pentagons instead of hexagons — one at each vertex, at every resolution.

They're deliberately placed over ocean so most workloads never touch one. But the fast neighbor routines return nothing at a pentagon, so any traversal that assumes six neighbors will silently produce a hole if it wanders into one.

### S2 treats a minimum level as non-negotiable

S2 has no pentagons and handles wrapping extents natively, both of which are lovely. But its region coverer takes a minimum level as a hard constraint rather than a hint, and it will happily hand back millions of cells rather than truncate to your maximum count.

That's a defensible design — the coverer's job is to cover, and silently returning a worse cover would be its own kind of bug. It does mean something has to estimate the cost of a cover before generating it, rather than discovering the problem afterward.

### S2's polar faces enclose the poles

S2 projects the sphere onto the six faces of a cube. Two of those faces are the polar caps, and they _enclose_ a pole rather than touching it. If you're used to reasoning about grids in terms of latitude bands, that takes a second to re-seat.

## What Else Is In There

Both packages cover the same ground in their own vocabulary — H3 speaks of resolutions, disks and rings, S2 of levels, tokens and cube faces:

**Traversal** — neighbors, parents, children, and compaction.

**Geometry** — cell boundaries as Cesium positions, cartographics, or rectangles.

**Covers** — from a rectangle, a polygon, or the current camera view.

**Two layer types** — `H3CellLayer` and `S2CellLayer` batch thousands of cells into a single `Primitive`, and `setCellStyle` recolors or hides one without touching geometry. The entity layers cost far more per cell and give each one a real Cesium `Entity` in exchange. Both support terrain clamping, extrusion into prisms, and optional outlines.

**Picking** — `CellPicker` resolves a click or hover on a batched primitive back to a cell id.

![H3 cells extruded into prisms above the globe](/assets/cesiumspatial/extruded.jpg)

## The Demo Is Half the Point

I kept the two packages' vocabularies separate on purpose — H3 terminology in the H3 package, S2 terminology in the S2 package — which means switching between them at runtime needs a small shim. The demo has one, and it's about thirty lines.

That demo is the piece I'd point at first. There are plenty of explanations of H3 and S2 out there, but not many places where you can just turn the knobs and watch what happens. You can:

- Switch between H3's 16 resolutions and S2's 31 levels
- Pin a resolution, or let the target cell edge size in pixels drive it
- Set a cell budget and watch the headroom as you fly around
- Clamp cells to terrain, or extrude them into prisms
- Click a cell to inspect it, hover to highlight
- Swap basemaps between Esri World Imagery, Natural Earth and OpenStreetMap

It works on the plain ellipsoid without a Cesium ion token. Paste one in if you want terrain.

![The S2 grid over a Cesium globe](/assets/cesiumspatial/s2-globe.jpg)

Every control in the demo maps to an option on the active view layer, so it doubles as a way to find the configuration you want before writing any code.

## Compatibility

Cesium is a peer dependency, so these never bundle a second copy of the engine. The declared range is `cesium >= 1.95`, and CI typechecks and tests against 1.95, 1.110, 1.120, 1.144 and the current release, weekly and on every change.

TypeScript is floored at 5.0, the first release that understands `moduleResolution: Bundler`, and the declarations are checked against 5.0, 5.4, 5.8 and current. A library that ships its own types is only as compatible as the oldest compiler that can read them, and nothing in a normal build would notice a declaration that needs a newer one.

Apache-2.0, source on [GitHub](https://github.com/StevenPG/cesium-spatial), full [API reference](https://stevenpg.github.io/cesium-spatial/api/) if you want the details.

## Go Turn the Knobs

If you take one thing from this post, make it the [demo](https://stevenpg.github.io/cesium-spatial/demo.html). Even if you never install either package, it's a good way to build intuition for how these two grids carve up a sphere — which is worth having whether you end up using H3, S2, or neither.

Issues and PRs welcome.
