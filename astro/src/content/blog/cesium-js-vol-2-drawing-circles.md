---
author: StevenPG
pubDatetime: 2024-08-24T12:00:00.000Z
title: Cesium JS Volume 2 - Drawing a Rectangle w/ Primitives & Entities
slug: cesium-vol-1-rectangle
featured: false
# TODO replace ogImage
ogImage: https://user-images.githubusercontent.com/53733092/215771435-25408246-2309-4f8b-a781-1f3d93bdf0ec.png
tags:
  - software
  - cesium
  - javascript
description: The second post about basic CesumJS components!
---

# Drawing Circles and Spheres in CesiumJS

This is the second article in my set of posts about CesiumJS, partly so that I can reference them later!

CesiumJS is a powerful open-source JavaScript library for creating 3D globes and maps. One of its many capabilities is drawing geometric shapes like circles and spheres. This article explores different approaches to creating these shapes using both the Entity API and the more performant Primitive API.

## Understanding the APIs

CesiumJS provides two main APIs for creating visual elements:

1. **Entity API**: High-level, easy-to-use API that's great for dynamic objects and simple applications
2. **Primitive API**: Lower-level API offering better performance, ideal for static objects or when handling large numbers of objects

## Drawing Circles

In CesiumJS, circles are actually polygons that approximate a circle's shape. They can be drawn on the surface of the globe or at any altitude.

### Using the Entity API

The Entity API makes it simple to create circles using `EllipseGraphics`:

```javascript
const viewer = new Cesium.Viewer('cesiumContainer');

// Create a circle on the surface
const surfaceCircle = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(-75.0, 40.0),
    ellipse: {
        semiMinorAxis: 300000.0, // radius in meters
        semiMajorAxis: 300000.0, // radius in meters
        material: Cesium.Color.RED.withAlpha(0.5),
        outline: true,
        outlineColor: Cesium.Color.BLACK
    }
});

// Create an elevated circle
const elevatedCircle = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(-74.0, 40.0, 200000.0),
    ellipse: {
        semiMinorAxis: 200000.0,
        semiMajorAxis: 200000.0,
        material: Cesium.Color.BLUE.withAlpha(0.5),
        outline: true,
        height: 200000.0, // height in meters
        extrudedHeight: 250000.0 // optional: creates a cylindrical volume
    }
});
```

### Using the Primitive API

For better performance, especially when drawing many circles, use the Primitive API:

```javascript
const viewer = new Cesium.Viewer('cesiumContainer');

// Create a circle using GeometryInstance and EllipseGeometry
const circleInstance = new Cesium.GeometryInstance({
    geometry: new Cesium.EllipseGeometry({
        center: Cesium.Cartesian3.fromDegrees(-75.0, 40.0),
        semiMinorAxis: 300000.0,
        semiMajorAxis: 300000.0,
        vertexFormat: Cesium.VertexFormat.DEFAULT
    }),
    attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.RED.withAlpha(0.5)
        )
    }
});

// Add the circle to the scene as a primitive
viewer.scene.primitives.add(
    new Cesium.GroundPrimitive({
        geometryInstances: circleInstance
    })
);
```

## Drawing Spheres

Spheres in CesiumJS can be created as either entities or primitives. They're particularly useful for representing points of interest, satellites, or other spherical objects in space.

### Using the Entity API

Creating a sphere with the Entity API uses `EllipsoidGraphics`:

```javascript
const viewer = new Cesium.Viewer('cesiumContainer');

const sphere = viewer.entities.add({
    position: Cesium.Cartesian3.fromDegrees(-75.0, 40.0, 500000.0),
    ellipsoid: {
        radii: new Cesium.Cartesian3(100000.0, 100000.0, 100000.0), // radius in meters
        material: Cesium.Color.GREEN.withAlpha(0.5),
        outline: true,
        outlineColor: Cesium.Color.BLACK,
        slicePartitions: 24,
        stackPartitions: 24
    }
});
```

### Using the Primitive API

For high-performance applications, create spheres using the Primitive API:

```javascript
const viewer = new Cesium.Viewer('cesiumContainer');

const sphereInstance = new Cesium.GeometryInstance({
    geometry: new Cesium.EllipsoidGeometry({
        center: Cesium.Cartesian3.fromDegrees(-75.0, 40.0, 500000.0),
        radii: new Cesium.Cartesian3(100000.0, 100000.0, 100000.0),
        vertexFormat: Cesium.VertexFormat.DEFAULT
    }),
    attributes: {
        color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.GREEN.withAlpha(0.5)
        )
    }
});

viewer.scene.primitives.add(
    new Cesium.Primitive({
        geometryInstances: sphereInstance,
        appearance: new Cesium.MaterialAppearance({
            material: new Cesium.Material({
                fabric: {
                    type: 'Color',
                    uniforms: {
                        color: Cesium.Color.GREEN.withAlpha(0.5)
                    }
                }
            })
        })
    })
);
```

## Performance Considerations

- Use the Entity API for:
  - Prototyping and simple applications
  - Dynamic objects that change frequently
  - When ease of use is more important than performance

- Use the Primitive API for:
  - Large numbers of static objects
  - Better rendering performance
  - More control over appearance and rendering

## Conclusion

CesiumJS provides flexible options for drawing circles and spheres, whether you need the simplicity of the Entity API or the performance of the Primitive API. Being open-source, you can also examine the source code on GitHub to understand how these shapes are implemented or contribute improvements to the library.

Remember that circles on a globe are actually approximations, and the number of segments used to create them can affect both visual quality and performance. For spheres, the `slicePartitions` and `stackPartitions` properties control the smoothness of the sphere's surface, with higher values creating smoother but more computationally intensive objects.
