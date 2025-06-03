---
author: StevenPG
pubDatetime: 2024-10-20T12:00:00.000Z
title: Cesium JS Volume 1 - Drawing a Rectangle w/ Primitives & Entities
slug: cesium-vol-1-rectangle
featured: false
# TODO replace ogImage
ogImage: https://user-images.githubusercontent.com/53733092/215771435-25408246-2309-4f8b-a781-1f3d93bdf0ec.png
tags:
  - software
  - cesium
  - javascript
description: The first of a series of posts about basic CeisumJS components!
---

# What is Cesium?

![Image of CesiumJS drawn on the globe](/assets/brave_1VcZYMyILD.png)

Cesium.js is a comprehensive JavaScript library that enables developers to create stunning and interactive 3D globes and maps. Built on top of WebGL, it leverages the power of modern web browsers to deliver high-performance, visually appealing geospatial applications.

One of the most significant aspects of Cesium.js is its commitment to open source. This means that the library's code is freely available, allowing developers to inspect, modify, and contribute to its development. The open-source nature of Cesium.js has fostered a vibrant community of developers who have contributed to its growth and functionality.

To put it simply, Cesium is a game engine on top of Google maps... or at least that's how I think of it.

Cesium is used by tons of different organizations to do 3d and 4d geospatial operations. Anything you can imagine on a globe is supported by Cesium.

I'm just starting my Cesium journey, and as I learn the basic pieces and learn lessons, I'll record some of the self-contained ones here.

Such as...

# Drawing a Simple Rectangle

Now, CesiumJS offers two primary APIs for creating and managing 3D objects on a globe: the Primitive API and the Entity API. While both may serve the same purpose, they differ in their approach and have wildly different performance characteristics.

#### Primitive API
- Direct manipulation: The Primitive API provides direct control over the underlying geometry and appearance of 3D objects.
- Performance-oriented: It is often more efficient for large datasets or complex visualizations due to its lower-level nature.

We might expect to use Cesium primitives for custom geometries, advanced rendering techniques, and performance-critical applications.

#### Entity API
- Data-driven approach: The Entity API represents 3D objects as data-driven entities, making it easier to manage and update objects based on changing data.
- Higher-level abstraction: It provides a more intuitive interface for common 3D object properties like position, orientation, and appearance.

The Entity API works best for data-driven visualizations, real-time updates, and applications that require easy management of 3D objects.

Put simply, the Primitive API is better suited for custom geometries and high performance rendering, while the Entity API is more convenient for developers simply trying to render known structures on screen, where performance is a secondary concern and the required 3d element matches an existing entity configuration.

A great example and introduction into Cesium is drawing something like a rectangle on the globe. There's a million reasons one might want to have a rectangle. Maybe to map out an area, or to display boundaries. Maybe to calculate a diagonal or get the distance around a center point.

## Drawing a Rectangle with Primitives

```typescript
// Initialize the Cesium viewer
const viewer = new Cesium.Viewer('cesiumContainer');

// Define rectangle coordinates (in radians)
const west = Cesium.Math.toRadians(-100.0);
const south = Cesium.Math.toRadians(30.0);
const east = Cesium.Math.toRadians(-90.0);
const north = Cesium.Math.toRadians(40.0);

// Create a filled rectangle
const filledRectanglePrimitive = new Cesium.GeometryInstance({
    geometry: new Cesium.RectangleGeometry({
        rectangle: new Cesium.Rectangle(west, south, east, north),
        vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT
    }),
    attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            new Cesium.Color(1.0, 0.0, 0.0, 0.5)
        )
    }
});

// Create an outline rectangle
const outlineRectanglePrimitive = new Cesium.GeometryInstance({
    geometry: new Cesium.RectangleOutlineGeometry({
        rectangle: new Cesium.Rectangle(west, south, east, north)
    }),
    attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.WHITE
        )
    }
});

// Add primitives to the scene
viewer.scene.primitives.add(new Cesium.Primitive({
    geometryInstances: filledRectanglePrimitive,
    appearance: new Cesium.PerInstanceColorAppearance({
        translucent: true,
        closed: true
    })
}));

viewer.scene.primitives.add(new Cesium.Primitive({
    geometryInstances: outlineRectanglePrimitive,
    appearance: new Cesium.PerInstanceColorAppearance({
        flat: true,
        renderState: {
            lineWidth: Math.min(2.0, viewer.scene.maximumAliasedLineWidth)
        }
    })
}));
```

## Drawing a Rectangle with Entities

```typescript
// Create a filled rectangle entity
const filledRectangleEntity = viewer.entities.add({
    rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(-100.0, 30.0, -90.0, 40.0),
        material: new Cesium.Color(0.0, 1.0, 0.0, 0.5),
        height: 0
    }
});

// Create an outline rectangle entity
const outlineRectangleEntity = viewer.entities.add({
    rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(-100.0, 30.0, -90.0, 40.0),
        fill: false,
        outline: true,
        outlineColor: Cesium.Color.YELLOW,
        outlineWidth: 2
    }
});

// Set camera to view the rectangles
viewer.zoomTo(viewer.entities);
```

Cesium provides so many more functionalities than this, but this works as a really basic overview
of some cesium functionality and a good opener to a series of HOW-TOs that I'll add to and update
as I learn more and more Cesium JS capabilities!

